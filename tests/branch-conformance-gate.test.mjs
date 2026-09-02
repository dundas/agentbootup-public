import { test, expect } from 'bun:test';
import path from 'path';
import { spawnSync } from 'child_process';

const scriptPath = path.resolve('scripts/branch-conformance-gate.mjs');

function runCli(args = []) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

function runNodeCli(args = []) {
  return spawnSync('node', [scriptPath, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

test('branch conformance gate self-suite passes', () => {
  const result = runCli();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('PASS allowed-write');
  expect(result.stdout).toContain('PASS disallowed-near-script');
  expect(result.stdout).toContain('PASS ambiguous-relative-write');
});

test('branch conformance gate also runs correctly under node', () => {
  const result = runNodeCli();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('PASS allowed-write');
});

test('branch conformance gate single allowed fixture exits 0', () => {
  const result = runCli(['--fixture', 'allowed-write']);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('expected: pass');
  expect(result.stdout).toContain('observed: pass');
});

test('branch conformance gate single disallowed fixture exits 1 with RO/RW failure details', () => {
  const result = runCli(['--fixture', 'disallowed-near-script']);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('expected: fail');
  expect(result.stdout).toContain('observed: fail');
  expect(result.stdout).toContain('writes outside RW root');
});

test('branch conformance gate rejects unknown fixtures', () => {
  const result = runCli(['--fixture', 'missing-fixture']);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('Unknown fixture');
});

test('branch conformance gate fails when fixture crashes before any write', () => {
  const result = runCli(['--fixture', 'crashing-runtime']);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('observed: fail');
  expect(result.stdout).toContain('execution failure');
  expect(result.stdout).toContain('child process exited 1');
});
