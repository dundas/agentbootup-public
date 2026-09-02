import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';

import { checkWrappers, delegatesToImplementation, WRAPPERS } from '../scripts/check-brain-msg-drift.ts';

/**
 * Pin the drift guard's ability to FAIL.
 *
 * The guard this replaced could not fail: both its assertions were substring-presence checks,
 * so a wrapper reduced to `process.exit(0)` — or one whose resolution path survived only inside
 * a comment — sailed through a required CI check. Nothing caught that for months, because
 * nothing tested the guard itself.
 *
 * These mutants are the ones that defeated the old guard. If a future edit regresses
 * delegatesToImplementation back toward string matching, they go green and this test goes red.
 */

const SKILL_SHIM_REL = '.claude/skills/cross-brain-message/brain-msg.ts';
const CHANNEL_B_REL = 'brain/brain-msg.ts';

const MUTANTS: Array<{ name: string; source: string; relPath: string }> = [
  {
    name: 'inert shim whose resolution path survives only in a comment',
    source: '#!/usr/bin/env bun\n// resolver removed. see ../../../brain/brain-msg.ts\nconsole.log("I delegate nowhere");\n',
    relPath: SKILL_SHIM_REL,
  },
  {
    name: 'resolver reduced to process.exit(0), retaining the "brain-msg" substring',
    source: '#!/usr/bin/env bun\n// brain-msg: resolver deleted\nprocess.exit(0);\n',
    relPath: CHANNEL_B_REL,
  },
  {
    name: 'wrapper that ignores BRAIN_MSG_SHARED_PATH and runs its own thing',
    source: '#!/usr/bin/env bun\nconsole.log("brain-msg doing my own thing, ../../../brain/brain-msg.ts");\n',
    relPath: CHANNEL_B_REL,
  },
  {
    name: 'empty wrapper',
    source: '',
    relPath: CHANNEL_B_REL,
  },
];

for (const mutant of MUTANTS) {
  test(`drift guard rejects: ${mutant.name}`, () => {
    const { ok, detail } = delegatesToImplementation(mutant.source, mutant.relPath);
    assert.equal(ok, false, `guard accepted a wrapper that does not delegate — it can no longer fail`);
    assert.ok(detail.length > 0, 'a rejection must explain itself');
  });
}

test('drift guard accepts the real wrappers it ships', () => {
  for (const { label, path: wrapperPath, relPath } of WRAPPERS) {
    assert.ok(fs.existsSync(wrapperPath), `${label} missing at ${wrapperPath}`);
    const { ok, detail } = delegatesToImplementation(fs.readFileSync(wrapperPath, 'utf8'), relPath);
    assert.equal(ok, true, `${label} failed to delegate: ${detail}`);
  }
});

const GOOD_CHANNEL_B = fs.readFileSync(WRAPPERS[0].path, 'utf8');
const GOOD_SKILL_SHIM = fs.readFileSync(WRAPPERS[1].path, 'utf8');
const INERT = '#!/usr/bin/env bun\n// brain-msg: resolver deleted\nprocess.exit(0);\n';

// Drive the real loop, not the shape of the WRAPPERS array. A test that only asserted
// WRAPPERS' contents would pass while a refactor quietly checked just the first entry.
test('checkWrappers evaluates the SECOND wrapper, not just the first', () => {
  const failures = checkWrappers([
    { label: 'first-is-fine', source: GOOD_CHANNEL_B, relPath: CHANNEL_B_REL },
    { label: 'second-is-inert', source: INERT, relPath: SKILL_SHIM_REL },
  ]);
  assert.equal(failures.length, 1, `expected the inert second wrapper to fail: ${JSON.stringify(failures)}`);
  assert.match(failures[0], /second-is-inert/);
});

test('checkWrappers evaluates the FIRST wrapper, not just the last', () => {
  const failures = checkWrappers([
    { label: 'first-is-inert', source: INERT, relPath: CHANNEL_B_REL },
    { label: 'second-is-fine', source: GOOD_SKILL_SHIM, relPath: SKILL_SHIM_REL },
  ]);
  assert.equal(failures.length, 1, `expected the inert first wrapper to fail: ${JSON.stringify(failures)}`);
  assert.match(failures[0], /first-is-inert/);
});

test('checkWrappers reports every failing wrapper, not just the first', () => {
  const failures = checkWrappers([
    { label: 'alpha', source: INERT, relPath: CHANNEL_B_REL },
    { label: 'beta', source: INERT, relPath: SKILL_SHIM_REL },
  ]);
  assert.equal(failures.length, 2);
});

test('checkWrappers passes the real wrappers this repo ships', () => {
  const failures = checkWrappers(
    WRAPPERS.map(({ label, path: p, relPath }) => ({ label, source: fs.readFileSync(p, 'utf8'), relPath }))
  );
  assert.deepEqual(failures, []);
});

// Diff directory NAMES, not counts: a concurrent process creating or reaping an unrelated
// brain-msg-drift-* dir would make a count comparison flaky.
test('drift guard leaves no temp directories behind', () => {
  const tmp = fs.realpathSync(os.tmpdir());
  const names = () => new Set(fs.readdirSync(tmp).filter((d) => d.startsWith('brain-msg-drift-')));

  const before = names();
  delegatesToImplementation(INERT, CHANNEL_B_REL);
  const leaked = [...names()].filter((d) => !before.has(d));

  assert.deepEqual(leaked, [], `guard leaked mkdtemp staging directories: ${leaked.join(', ')}`);
});
