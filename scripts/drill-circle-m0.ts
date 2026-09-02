#!/usr/bin/env bun
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCircleAgentAdapter } from '../lib/runtime-adapters/circle-agent.js';
import { validateCircleCandidateArtifact, validateDisjointCircleRoots } from '../lib/runtime-adapters/circle-candidate.js';
import { findRawSecretViolations } from '../lib/runtime-adapters/security.js';

const policy = JSON.parse(fs.readFileSync(new URL('../config/circle-m0-transition-v1.json', import.meta.url), 'utf8'));
const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1] ?? null; };
const required = (name: string) => { const value = arg(name); if (!value) throw new Error(`${name} is required`); return path.resolve(value); };
function makeCleanEvidenceRoot(root: string) {
  if (fs.existsSync(root) && fs.readdirSync(root).length) throw new Error('--evidence-root must be absent or empty; refusing to overwrite retained evidence');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
}

const requestedRuntimeRoot = required('--runtime-root');
const requestedEvidenceRoot = required('--evidence-root');
const { runtime: runtimeRoot, evidence: evidenceRoot } = validateDisjointCircleRoots(requestedRuntimeRoot, requestedEvidenceRoot);
const evidenceRootCreated = !fs.existsSync(evidenceRoot);
makeCleanEvidenceRoot(evidenceRoot);

let retain = false;
try {
  if (!fs.statSync(runtimeRoot).isDirectory()) throw new Error('--runtime-root must be a protected-producer sanitized artifact directory');
  const { attestation: generator, artifact_sha256: digest } = validateCircleCandidateArtifact(runtimeRoot, policy);
  const platform = { os: os.platform(), os_version: os.release(), architecture: os.arch() === 'x64' ? 'amd64' : os.arch(), runtime: 'bun', runtime_version: Bun.version };
  if (platform.os !== 'linux' || platform.architecture !== 'amd64' || platform.runtime_version !== policy.observed_runtime.bun_version) throw new Error(`exact candidate lane required: linux/amd64 Bun ${policy.observed_runtime.bun_version}`);

  const snapshots = path.join(evidenceRoot, 'snapshot');
  const targets = [path.join(evidenceRoot, 'restores/first'), path.join(evidenceRoot, 'restores/second')];
  fs.mkdirSync(snapshots, { recursive: true });
  const adapter = createCircleAgentAdapter({ source_root: runtimeRoot, runtime_version: generator.runtime_version, adapter_version: '0.1.0-draft', source_commit: generator.source_commit, platform,
    package_pins: generator.package_pins, toolset_pins: generator.toolset_pins,
  });
  const results: Record<string, any> = {};
  results.detect = await adapter.detect();
  results.inventory = await adapter.inventory();
  results.quiesce = await adapter.quiesce();
  if (results.quiesce.status !== 'success') throw new Error(`candidate consistency boundary blocked: ${results.quiesce.error?.code ?? results.quiesce.status}`);
  results.snapshot = await adapter.snapshot({ snapshot_root: snapshots });
  if (results.snapshot.status !== 'success') throw new Error(`candidate snapshot failed: ${results.snapshot.error?.code ?? results.snapshot.status}`);
  results.restores = [];
  for (const target of targets) {
    const restore = await adapter.restore({ snapshot_path: results.snapshot.diagnostics.snapshot_path, target_root: target });
    const verify = restore.status === 'success' ? await adapter.verify({ snapshot_path: results.snapshot.diagnostics.snapshot_path, target_root: target }) : null;
    results.restores.push({ restore, verify });
    if (restore.status !== 'success' || verify?.error?.code !== 'MANUAL_REVIEW_REQUIRED') throw new Error('candidate restore/static verification did not reach the expected non-qualifying boundary');
  }
  results.resume = await adapter.resume();
  const manifest = JSON.parse(fs.readFileSync(results.snapshot.diagnostics.manifest_path, 'utf8'));
  const privacyViolations = findRawSecretViolations({ results, manifest }, { accountingContext: 'runtime_backup_manifest' });
  if (privacyViolations.length) throw new Error(`automated privacy gate rejected retained evidence (${privacyViolations.length} violation(s))`);
  const evidence = {
    evidence_version: 3, qualification: 'candidate_non_qualifying', freeze: 'blocked', lane: 'sanitized_artifact_consumer',
    source: { repository: 'private:dundas/circle_agent', commit: generator.source_commit, candidate_code_received_private_checkout: false },
    runtime: { platform, generator_commit: generator.generator_commit, artifact_sha256: digest, lock_sha256: generator.lock_sha256 },
    results,
    manifest: { sha256: results.snapshot.diagnostics.manifest_sha256, accounting: manifest.accounting, inventory: manifest.inventory, exclusions: manifest.exclusions, dependency_pins: manifest.dependency_pins, integrity: manifest.integrity },
    privacy: { protected_producer_review: generator.privacy_review, automated_scan: 'passed', human_review_of_retained_candidate: 'required_before_upload' },
    limitations: [`Circle remains deferred and Agentbootup ${policy.observed_runtime.agentbootup_version} remains the audited old pin.`, 'This source-only harness performs static candidate restore evidence only.', 'Actual Circle boot, gate canary, authenticated chat smoke, /readyz, /healthz, owner review, and security review remain outstanding.'],
    rerun: 'Use a new empty --evidence-root with the same immutable sanitized artifact; an existing evidence root is never overwritten.',
    rollback: `Delete only the operator-supplied evidence root (${evidenceRoot}); the sanitized input artifact and private Circle source are never mutated.`,
  };
  fs.writeFileSync(path.join(evidenceRoot, 'candidate-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  retain = true;
  console.log(JSON.stringify({ status: 'candidate_evidence_retained', evidence_root: evidenceRoot, qualification: evidence.qualification }));
} finally {
  if (!retain && evidenceRootCreated) fs.rmSync(evidenceRoot, { recursive: true, force: true });
}
