import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { REQUIRED_PROOFS, buildApprovalReceipt, evaluateProofs, parseReceiptEventStream, parseSoakSummary, prepareEvidenceOutput, realSoak, safeProbeFailure, validateApprovalReceipt, verdictFromProbe, writeNewEvidence } from '../tasks/evidence/0072/qualify-mech-plane-runtime-successor.ts';

const root = new URL('..', import.meta.url);
const evidenceUrl = new URL('tasks/evidence/0072/mech-plane-runtime-successor-rerun-2026-08-18.json', root);
const approvalEvidenceUrl = new URL('tasks/evidence/0072/mech-plane-runtime-approval-linux-arm64-ab4c156-2026-08-20.json', root);
const harnessUrl = new URL('tasks/evidence/0072/qualify-mech-plane-runtime-successor.ts', root);
const harnessPath = new URL('tasks/evidence/0072/qualify-mech-plane-runtime-successor.ts', root).pathname;
const evidenceDir = dirname(harnessPath);
const secureOutputRefusal = /secure descriptor-relative evidence output is unavailable/;
const t_after = [];
test.after?.(async () => { for (const d of t_after) await rm(d, { recursive: true, force: true }); });

function runQualifier(plane, output, extraArgs = []) {
  return spawnSync('bun', [harnessPath, '--mech-plane', plane, '--output', output, ...extraArgs], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
}

test('historical Task 1.3 successor evidence retains its NO_GO failure', async () => {
  const evidence = JSON.parse(await readFile(evidenceUrl, 'utf8'));
  assert.equal(evidence.source.featureCommit, '143036bc9a1712d125220f6b1462ffab3115a3ac');
  assert.equal(evidence.source.docsCommit, '8e803126c9ba7fb3bda97e69b4ab5127048e0c02');
  assert.equal(evidence.artifact.identity, '@mech/run@0.4.6');
  assert.equal(evidence.artifact.integrity, 'sha512-O3spSfiBHBJo7K3JDFuCEt/g5Cn0gtEwxTNNH7Rzzs+eV01Rg44gVFS71JIfKcfye3Wv4cN3i+lMoA1Llah8ng==');
  assert.equal(evidence.reviewedPlaneEvidence.matrix, 'codex/local/plane-bound-live');
  for (const key of ['bindingDigest', 'finiteExpiry', 'atomicDenyReplay', 'disconnectCancellation']) assert.equal(evidence.reviewedPlaneEvidence[key], true);
  assert.equal(evidence.reviewedPlaneEvidence.planeRemoteLocalMode, false);
  assert.equal(evidence.reviewedPlaneEvidence.serverRouteMounted, false);
  assert.equal(evidence.independentRuntime.executed, true);
  assert.equal(evidence.independentRuntime.watchdogTerminationApplied, false);
  assert.deepEqual(evidence.independentRuntime, {
    executed: true, watchdogTerminationApplied: false, ok: false, classification: 'real_probe_command_failed', phase: null,
    stderrSha256: '2f0168ecc8e8fbcafa067d88ae350bac94fd78d67e65ead26a5128e33f01c3da', stderrBytes: 142, exitCode: 1,
  });
  assert.equal(evidence.verdict, 'NO_GO');
  assert.deepEqual(evidence.blockers, ['real_probe_command_failed']);
});

test('Task 1.3 exact-main runtime approval receipt records a complete bounded GO matrix', async () => {
  const evidence = JSON.parse(await readFile(approvalEvidenceUrl, 'utf8'));
  assert.equal(evidence.schemaVersion, 'agentbootup.mech-plane-runtime-approval-qualification.v2');
  assert.equal(evidence.verdict, 'GO');
  assert.deepEqual(evidence.source, {
    repository: 'dundas/mech-plane',
    commit: 'ab4c156313d6d5b43c00edf5458e2e3a38ab3e6c',
    directParent: '3822a1bc9a27ac402414de708c8f9f8d781979df',
    cleanBefore: true,
    cleanAfter: true,
  });
  assert.match(evidence.qualifier.sourceSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(evidence.integrityTuple.platform, {
    os: 'linux', architecture: 'arm64', kernelArchitecture: 'aarch64',
  });
  assert.equal(evidence.integrityTuple.packages.mechRun.identity, '@mech/run@0.4.6');
  assert.equal(evidence.integrityTuple.packages.mechRun.verified, true);
  assert.equal(evidence.integrityTuple.packages.codexLauncher.verified, true);
  assert.equal(evidence.integrityTuple.packages.codexLinuxArm64.verified, true);
  assert.equal(evidence.finalSummary.schemaVersion, 'mech-plane.runtime-approval-soak.v2');
  assert.equal(evidence.finalSummary.cycles, 2);
  assert.equal(evidence.finalSummary.passed, true);
  assert.equal(evidence.finalSummary.results.length, 8);
  assert.equal(evidence.exitCode, 0);
  assert.deepEqual(evidence.caseFailures, []);
  const retainedKeys = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) { retainedKeys.add(key); visit(child); }
  };
  visit(evidence);
  for (const forbidden of ['providerOutput', 'messages', 'prompts', 'toolName', 'toolArguments', 'localPath', 'stack', 'credentials', 'challengeId', 'invocationId']) {
    assert.equal(retainedKeys.has(forbidden), false, `${forbidden} must not enter the immutable receipt`);
  }
  assert.deepEqual(validateApprovalReceipt(evidence), {
    schemaVersion: 'agentbootup.mech-plane-runtime-successor-reconcile.v6',
    source: {
      targetCommit: 'ab4c156313d6d5b43c00edf5458e2e3a38ab3e6c',
      parentCommit: '3822a1bc9a27ac402414de708c8f9f8d781979df',
      clean: true,
    },
    artifact: {
      identity: '@mech/run@0.4.6',
      integrity: 'sha512-O3spSfiBHBJo7K3JDFuCEt/g5Cn0gtEwxTNNH7Rzzs+eV01Rg44gVFS71JIfKcfye3Wv4cN3i+lMoA1Llah8ng==',
      registryVerified: true,
    },
    independentRuntime: {
      executed: true, ok: true, outputDrainComplete: true,
      nativeToolEventObserved: true, zeroRetries: true, zeroCaseFailures: true,
      allowEffectsObserved: 2, deniedEffectsObserved: 6, cases: 8,
      nativeToolObservedEveryRow: true,
      approvalProofObserved: true, approvalProofNotObserved: [],
    },
    requiredProofsSatisfied: REQUIRED_PROOFS.map((proof) => proof.id),
    verdict: 'GO', blockers: [],
  });

  for (const mutate of [
    (copy) => { copy.source.commit = '0'.repeat(40); },
    (copy) => { copy.source.directParent = '0'.repeat(40); },
    (copy) => { copy.qualifier.sourceSha256 = '0'.repeat(64); },
    (copy) => { copy.integrityTuple.packages.mechRun.verified = false; },
    (copy) => { copy.finalSummary.results[0].bindingDigestPresent = false; },
    (copy) => { copy.eventStream.find((event) => event.event === 'case_observed').approvalRequestCount = 99; },
    (copy) => { delete copy.eventStream.find((event) => event.event === 'case_observed').approvalDecisionsSubmitted; },
    (copy) => { copy.eventStream = copy.eventStream.filter((event) => event.event !== 'approval_requested'); },
    (copy) => { copy.eventStream = copy.eventStream.filter((event) => event.event !== 'native_tool_observed'); },
    (copy) => { copy.eventStream.push({ event: 'case_retrying', cycle: 1, mode: 'allow', attempt: 1, maxAttempts: 3, reason: 'no_native_approval' }); },
    (copy) => { copy.eventStream.push({ event: 'case_failed', cycle: 1, mode: 'allow', attempt: 1, failureCode: 'unknown' }); },
  ]) {
    const malformed = structuredClone(evidence); mutate(malformed);
    assert.throws(() => validateApprovalReceipt(malformed), /invalid runtime approval receipt|bindingDigestPresent=false/);
  }

  const generated = buildApprovalReceipt({
    eventStream: evidence.eventStream,
    finalSummary: evidence.finalSummary,
  }, {
    platform: evidence.integrityTuple.platform,
    runtime: evidence.integrityTuple.runtime,
  });
  assert.deepEqual(generated, evidence, 'the checked-in qualifier must generate the retained receipt schema');
});

test('receipt event parser retains only allowlisted bounded fields', () => {
  const parsed = parseReceiptEventStream([
    JSON.stringify({ event: 'native_tool_observed', cycle: 1, mode: 'allow', nativeToolObserved: true, toolName: 'drop', arguments: 'drop' }),
    JSON.stringify({ event: 'approval_requested', cycle: 1, mode: 'allow', approvalRequested: true, prompt: 'drop', localPath: '/drop' }),
    JSON.stringify({ event: 'provider_output', message: 'drop' }),
    'not json',
  ].join('\n'));
  assert.deepEqual(parsed, [
    { event: 'native_tool_observed', cycle: 1, mode: 'allow', nativeToolObserved: true },
    { event: 'approval_requested', cycle: 1, mode: 'allow', approvalRequested: true },
  ]);
});

test('verdict is derived from required proofs — an unobserved proof cannot yield GO', () => {
  const complete = { executed: true, ok: true, outputDrainComplete: true, cases: 8,
    nativeToolEventObserved: true, nativeToolObservedEveryRow: true,
    zeroRetries: true, zeroCaseFailures: true, approvalProofObserved: true };
  assert.deepEqual(evaluateProofs(complete).blockers, []);
  assert.equal(evaluateProofs(complete).verdict, 'GO');

  // The live case: soak emits no approval-proof fields. This MUST block, not inform.
  const noProof = { ...complete, approvalProofObserved: false };
  assert.equal(evaluateProofs(noProof).verdict, 'NO_GO');
  assert.ok(evaluateProofs(noProof).blockers.includes('approval_proof_not_observed'));

  // Every declared requirement must be individually load-bearing: drop each one and the
  // verdict must flip. A requirement that cannot fail is not a requirement.
  for (const proof of REQUIRED_PROOFS) {
    const broken = { ...complete };
    for (const k of ['executed', 'ok', 'outputDrainComplete', 'nativeToolEventObserved', 'nativeToolObservedEveryRow', 'zeroRetries', 'zeroCaseFailures', 'approvalProofObserved']) {
      if (proof.holds({ ...complete, [k]: false }) === false) broken[k] = false;
    }
    if (proof.id === 'full_two_cycle_matrix') broken.cases = 7;
    const evaluated = evaluateProofs(broken);
    assert.equal(evaluated.verdict, 'NO_GO', `${proof.id} must be load-bearing`);
    assert.ok(evaluated.blockers.includes(proof.blocker), `${proof.id} must emit ${proof.blocker}`);
  }
});

test('successor reconciler refuses an invalid or mutable source before emitting a result', async () => {
  const source = await readFile(harnessUrl, 'utf8');
  assert.match(source, /Plane checkout is not clean/);
  assert.match(source, /independent_real_codex_runtime_not_exercised/);
  assert.match(source, /outside base must be an absolute directory outside the Plane checkout/);
  assert.match(source, /outside base must not be inside a system temporary directory/);
  assert.match(source, /proc\.kill\(9\)/);
  assert.match(source, /ab4c156313d6d5b43c00edf5458e2e3a38ab3e6c/);
  assert.match(source, /3822a1bc9a27ac402414de708c8f9f8d781979df/);
  assert.match(source, /TARGET_PARENT_COMMIT/);
  assert.doesNotMatch(source, /TARGET_PARENT_COMMITS|REQUIRED_ANCESTOR_COMMIT/);
  assert.match(source, /codexPackageIntegrityVerified/);
  assert.match(source, /codexLauncherIntegrityVerified/);
  assert.match(source, /credentialProfile/);
  assert.match(source, /prepareVerifiedCodexRuntime/);
  assert.match(source, /verified Codex runtime qualification requires linux\/arm64/);
  assert.doesNotMatch(source, /remote-chat-connector|remote-local-relay-protocol|remote-local-chat/);
});

test('successor reconciler rejects a system temporary effect base before any source or probe action', async (t) => {
  const plane = await mkdtemp('/tmp/mech-plane-clone-');
  const scratch = await mkdtemp(join(evidenceDir, '.qualification-temp-base-test-'));
  t.after(async () => { await rm(plane, { recursive: true, force: true }); await rm(scratch, { recursive: true, force: true }); });
  const output = join(scratch, 'would-not-write.json');
  const result = runQualifier(plane, output, ['--allow-real-agent', '--outside-base', '/tmp']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside base must not be inside a system temporary directory/);
  await assert.rejects(readFile(output, 'utf8'), { code: 'ENOENT' });
});

test('successor reconciler never writes outside AgentBootup evidence or over existing evidence', async (t) => {
  const plane = await mkdtemp('/tmp/mech-plane-clone-');
  const outsideOutput = join(plane, 'qualification.json');
  const scratch = await mkdtemp(join(evidenceDir, '.qualification-output-test-'));
  t.after(async () => { await rm(plane, { recursive: true, force: true }); await rm(scratch, { recursive: true, force: true }); });

  const outside = runQualifier(plane, outsideOutput);
  assert.notEqual(outside.status, 0);
  assert.match(outside.stderr, /evidence output must be a new file under/);
  await assert.rejects(readFile(outsideOutput, 'utf8'), { code: 'ENOENT' });

  const existingOutput = join(scratch, 'existing.json');
  await writeFile(existingOutput, 'preserve this evidence\n');
  const existing = runQualifier(plane, existingOutput);
  assert.notEqual(existing.status, 0);
  assert.match(existing.stderr, /refusing to overwrite existing evidence output|secure descriptor-relative evidence output is unavailable/);
  assert.equal(await readFile(existingOutput, 'utf8'), 'preserve this evidence\n');
});

test('successor reconciler refuses a symlinked output without following it', async (t) => {
  const plane = await mkdtemp('/tmp/mech-plane-clone-');
  const scratch = await mkdtemp(join(evidenceDir, '.qualification-symlink-test-'));
  const outsideTarget = join(plane, 'outside-target.json');
  const outputLink = join(scratch, 'linked-output.json');
  await writeFile(outsideTarget, 'outside remains unchanged\n');
  await symlink(outsideTarget, outputLink);
  t.after(async () => { await rm(plane, { recursive: true, force: true }); await rm(scratch, { recursive: true, force: true }); });

  const result = runQualifier(plane, outputLink);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing to overwrite existing evidence output|secure descriptor-relative evidence output is unavailable/);
  assert.equal(await readFile(outsideTarget, 'utf8'), 'outside remains unchanged\n');

  const escapingParent = join(scratch, 'outside-parent');
  const escapedOutput = join(escapingParent, 'would-escape.json');
  await symlink(plane, escapingParent);
  const parentResult = runQualifier(plane, escapedOutput);
  assert.notEqual(parentResult.status, 0);
  assert.match(parentResult.stderr, /evidence output parent must be a real directory|secure descriptor-relative evidence output is unavailable/);
  await assert.rejects(readFile(join(plane, 'would-escape.json'), 'utf8'), { code: 'ENOENT' });
});

test('descriptor-held parent cannot be redirected to an external write after preflight', async (t) => {
  const scratch = await mkdtemp(join(evidenceDir, '.qualification-parent-race-test-'));
  const outside = await mkdtemp('/tmp/mech-plane-external-');
  t.after(async () => { await rm(scratch, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  const parent = join(scratch, 'parent');
  const detachedParent = join(scratch, 'parent-detached');
  const output = join(parent, 'result.json');
  const externalOutput = join(outside, 'result.json');
  await mkdir(parent);

  let prepared;
  try {
    prepared = await prepareEvidenceOutput(output);
  } catch (error) {
    assert.match(String(error), secureOutputRefusal);
    await assert.rejects(readFile(externalOutput, 'utf8'), { code: 'ENOENT' });
    return;
  }
  try {
    await rename(parent, detachedParent);
    await symlink(outside, parent);
    await writeNewEvidence(prepared, { safe: true });
  } finally {
    await prepared.parent.close();
  }
  assert.equal(await readFile(join(detachedParent, 'result.json'), 'utf8'), '{\n  "safe": true\n}\n');
  await assert.rejects(readFile(externalOutput, 'utf8'), { code: 'ENOENT' });
});

test('real-agent parser admits only the complete two-cycle allow/deny/expiry/disconnect matrix', () => {
  const results = [];
  for (const cycle of [1, 2]) {
    results.push(
      { cycle, mode: 'allow', nativeToolObserved: true, approvalRequested: true, bindingDigestPresent: true, expiryPresent: true, approvalOutcome: { approved: true, decision: 'once', reason: 'resolved' }, effectObserved: true, approvalRequestCount: 1, approvalDecisionsSubmitted: 1, approvalDecisionsAccepted: 1 },
      { cycle, mode: 'deny', nativeToolObserved: true, approvalRequested: true, bindingDigestPresent: true, expiryPresent: true, approvalOutcome: { approved: false, decision: 'deny', reason: 'resolved' }, effectObserved: false, approvalRequestCount: 1, approvalDecisionsSubmitted: 1, approvalDecisionsAccepted: 1 },
      { cycle, mode: 'expiry', nativeToolObserved: true, approvalRequested: true, bindingDigestPresent: true, expiryPresent: true, approvalOutcome: { approved: false, decision: 'deny', reason: 'expired' }, effectObserved: false, approvalRequestCount: 1, approvalDecisionsSubmitted: 0, approvalDecisionsAccepted: 0 },
      { cycle, mode: 'disconnect', nativeToolObserved: true, approvalRequested: true, bindingDigestPresent: true, expiryPresent: true, approvalOutcome: { approved: false, decision: 'deny', reason: 'cancelled' }, effectObserved: false, approvalRequestCount: 1, approvalDecisionsSubmitted: 0, approvalDecisionsAccepted: 0 },
    );
  }
  for (const row of results) row.runtime = row.mode === 'disconnect' ? { stopReason: 'cancelled', exitCode: null } : { stopReason: 'end_turn', exitCode: 0 };
  const summary = { schemaVersion: 'mech-plane.runtime-approval-soak.v2', runtime: { package: '@mech/run', version: '0.4.6', provider: 'codex' }, cycles: 2, passed: true, results };
  assert.deepEqual(parseSoakSummary(JSON.stringify(summary)), {
    allowEffectsObserved: 2, deniedEffectsObserved: 6, cases: 8,
    nativeToolObservedEveryRow: true,
    approvalProofObserved: true, approvalProofNotObserved: [],
  });

  // A historical soak schema that does not carry the approval-proof fields must be
  // reported as NOT OBSERVED, never inferred as satisfied.
  const withoutProof = JSON.parse(JSON.stringify(summary));
  for (const row of withoutProof.results) { delete row.bindingDigestPresent; delete row.expiryPresent; }
  const parsedWithout = parseSoakSummary(JSON.stringify(withoutProof));
  assert.equal(parsedWithout.approvalProofObserved, false);
  assert.deepEqual(parsedWithout.approvalProofNotObserved, ['bindingDigest', 'expiry']);

  // A field that is PRESENT and false is a hard failure, not a missing observation.
  for (const field of ['bindingDigestPresent', 'expiryPresent']) {
    const falsified = JSON.parse(JSON.stringify(summary));
    falsified.results[3][field] = false;
    assert.throws(() => parseSoakSummary(JSON.stringify(falsified)), new RegExp(`${field}=false`));
  }
  summary.results[3].effectObserved = true;
  assert.throws(() => parseSoakSummary(JSON.stringify(summary)), /effect/);
});

test('timeout and malformed probe output remain NO-GO with bounded diagnostics', () => {
  const failure = safeProbeFailure('{"event":"spawn_started","cycle":1,"mode":"deny"}\nsecret-ish text', true, 143);
  assert.deepEqual({ classification: failure.classification, phase: failure.phase, exitCode: failure.exitCode }, { classification: 'real_probe_timeout_or_stall', phase: 'cycle-1-deny-spawn_started', exitCode: 143 });
  assert.match(failure.stderrSha256, /^[a-f0-9]{64}$/);
  assert.equal(verdictFromProbe({ ok: false }), 'NO_GO');
  assert.equal(verdictFromProbe({ ok: true }), 'GO');
});

test('real soak reports when its watchdog terminates a stalled probe', async (t) => {
  const plane = await mkdtemp(join(tmpdir(), 'mech-plane-stalled-soak-'));
  const outsideBase = await mkdtemp(join(tmpdir(), 'agentbootup-stalled-soak-effect-'));
  t.after(async () => { await rm(plane, { recursive: true, force: true }); await rm(outsideBase, { recursive: true, force: true }); });
  await mkdir(join(plane, 'scripts'));
  await writeFile(join(plane, 'scripts', 'soak-runtime-approval.ts'), 'await new Promise(() => {});\n');

  // Keep the test's residual output-drain window well below Bun's per-test deadline.
  // Production qualification retains its 15-second window for a real process tree.
  const result = await realSoak(plane, outsideBase, 50, 500);
  assert.equal(result.ok, false);
  assert.equal(result.classification, 'real_probe_timeout_or_stall');
  assert.equal(result.watchdogTerminationApplied, true);
  assert.equal(verdictFromProbe(result), 'NO_GO');
});
