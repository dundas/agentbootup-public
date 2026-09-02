#!/usr/bin/env node
/**
 * Smoke: live runtime-source doctor check (PRD-0063 Task 5.2 / Gate 6.3).
 *
 * Runs `checkRuntimeSourceMatches` against the REAL machine state — the live
 * `~/Library/LaunchAgents`, `~/.agentbootup/runtime-source.json`, `launchctl list`, and
 * `ps` — and prints the machine-tier result. Reads only; it writes nothing and mutates
 * no daemon. Paste this output into the PR (AC-2).
 *
 * Asserts the load-bearing invariant `sum(verdicts) == total_labels` (proves nothing was
 * silently skipped) and reports the tolerance `source_mismatch >= 90 AND ok >= 1` for the
 * main machine (where the intended root is the installed package and the fleet runs a
 * dev checkout).
 */
import { checkRuntimeSourceMatches } from '../lib/doctor/runtime-source-check.js';

const TOLERANCE_SOURCE_MISMATCH = 90;
const TOLERANCE_OK = 1;

const result = await checkRuntimeSourceMatches({});

const sum =
  result.counts.ok +
  result.counts.source_mismatch +
  result.counts.path_missing +
  result.counts.plist_invalid +
  result.counts.process_mismatch;

console.log(JSON.stringify({
  state: result.state,
  severity: result.severity,
  message: result.message,
  machine_id: result.machine_id,
  declaration: result.declaration,
  total_labels: result.total_labels,
  counts: result.counts,
  offending_labels: result.offending_labels,
}, null, 2));

console.log('\n--- per-label verdicts ---');
for (const l of result.labels) {
  console.log(`${l.verdict.padEnd(16)} ${l.label}${l.scriptPath ? `  (${l.scriptPath})` : ''}${l.reason ? `  [${l.reason}]` : ''}`);
}

console.log(`\n--- invariant ---`);
console.log(`sum(verdicts) = ${sum}, total_labels = ${result.total_labels}, match = ${sum === result.total_labels}`);
if (sum !== result.total_labels) {
  console.error('FAIL: invariant violated — a label was silently skipped');
  process.exit(1);
}

console.log(`\n--- tolerance (main machine, AC-2) ---`);
const withinTolerance = result.counts.source_mismatch >= TOLERANCE_SOURCE_MISMATCH && result.counts.ok >= TOLERANCE_OK;
console.log(`source_mismatch >= ${TOLERANCE_SOURCE_MISMATCH}: ${result.counts.source_mismatch} (${result.counts.source_mismatch >= TOLERANCE_SOURCE_MISMATCH})`);
console.log(`ok >= ${TOLERANCE_OK}: ${result.counts.ok} (${result.counts.ok >= TOLERANCE_OK})`);
console.log(`within tolerance: ${withinTolerance}`);

// Smoke PASS = the invariant held AND the result is within the main-machine tolerance.
// The check's own `fail` state is the EXPECTED detection (the fleet runs a dev checkout),
// not a smoke failure — detection is the whole point of this check.
const passed = sum === result.total_labels && withinTolerance;
console.log(`\nSMOKE: ${passed ? 'PASS' : 'FAIL'}`);
process.exit(passed ? 0 : 1);