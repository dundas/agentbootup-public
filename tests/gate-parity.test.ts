import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

/**
 * The blocking CI job and `npm test` must run the same phase-1 path list.
 *
 * They drifted once already: the workflow claimed to "mirror the first half of `npm test`"
 * while omitting tests/auth/ and naming only tests/provision.test.ts. Five root-level suites
 * never ran in CI as a result, and tests/brain-msg-wrapper.test.ts stayed red for 36 days
 * without anyone noticing. A comment asking the two lists to stay in lockstep is intent;
 * this test is effect.
 */

const repoRoot = path.resolve(import.meta.dirname, '..');

function phase1PathsFromPackageJson(): string[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const script: string = pkg.scripts.test;
  // `npm test` is "<env> bun test <phase1 paths> && <env> bun test tests/daemon/"
  const phase1 = script.split('&&')[0];
  return extractBunTestPaths(phase1);
}

const PHASE1_STEP_NAME = 'Run the portable half of the declared suite';

/**
 * Anchor on the named phase-1 step, not on "any `bun test` line in the file". Matching the
 * first such line would silently compare against the wrong step; asserting the file contains
 * exactly one would false-fail on any unrelated future `bun test` step. Both are the defect
 * this test exists to prevent, pointed at itself.
 */
function phase1PathsFromWorkflow(): string[] {
  const lines = fs
    .readFileSync(path.join(repoRoot, '.github/workflows/test.yml'), 'utf8')
    .split('\n')
    .map((l) => l.trim());

  const stepIndexes = lines
    .map((l, i) => (l === `- name: ${PHASE1_STEP_NAME}` ? i : -1))
    .filter((i) => i !== -1);

  assert.equal(
    stepIndexes.length,
    1,
    `expected exactly one step named "${PHASE1_STEP_NAME}" in test.yml, found ${stepIndexes.length}`
  );

  // The step's `run:` is the next `run:` line after its name, before the next step begins.
  const start = stepIndexes[0];
  const end = lines.findIndex((l, i) => i > start && l.startsWith('- name: '));
  const body = lines.slice(start, end === -1 ? lines.length : end);
  const runLine = body.find((l) => l.startsWith('run: '));

  assert.ok(runLine, `step "${PHASE1_STEP_NAME}" has no \`run:\` line`);
  assert.ok(
    runLine.includes('bun test '),
    `step "${PHASE1_STEP_NAME}" no longer invokes \`bun test\`: ${runLine}`
  );
  return extractBunTestPaths(runLine);
}

function extractBunTestPaths(fragment: string): string[] {
  const marker = 'bun test ';
  const start = fragment.indexOf(marker);
  assert.notEqual(start, -1, `no "bun test" found in: ${fragment}`);
  return fragment
    .slice(start + marker.length)
    .trim()
    .split(/\s+/)
    .filter((token) => !token.startsWith('-') && token !== '2>&1')
    .sort();
}

test('CI phase-1 path list matches the npm test phase-1 path list', () => {
  const fromPkg = phase1PathsFromPackageJson();
  const fromCi = phase1PathsFromWorkflow();

  assert.ok(fromPkg.length > 0, 'package.json phase-1 path list parsed as empty');
  assert.deepEqual(
    fromCi,
    fromPkg,
    `CI and npm test run different suites.\n  npm test: ${fromPkg.join(' ')}\n  CI:       ${fromCi.join(' ')}`
  );
});

test('the phase-1 path list globs root-level tests rather than naming one file', () => {
  const fromPkg = phase1PathsFromPackageJson();
  // The glob must cover root-level test files, not enumerate them. Originally
  // tests/*.test.ts; widened to tests/*.test.* so the 21 root-level .test.mjs
  // files run in CI too (the .ts-only glob silently orphaned them). Asserting the
  // widened glob keeps the protective intent: any future narrowing back to a
  // single extension, or regression to enumerating individual files, fails here.
  assert.ok(
    fromPkg.includes('tests/*.test.*'),
    'phase-1 must glob tests/*.test.* — enumerating individual root-level files (or a single-extension glob) silently orphans new ones'
  );
});
