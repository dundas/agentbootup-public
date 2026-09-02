import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractCwd, getPositionalArgs } from './args.js';

describe('extractCwd', () => {
  test('--path resolves correctly', () => {
    const result = extractCwd(['--path', '/tmp/proj']);
    assert.deepEqual(result, { cwd: '/tmp/proj', args: [] });
  });

  test('--cwd still works (regression)', () => {
    const result = extractCwd(['--cwd', '/tmp/proj']);
    assert.deepEqual(result, { cwd: '/tmp/proj', args: [] });
  });

  test('--path wins over --cwd when both present (--cwd first)', () => {
    const result = extractCwd(['--cwd', '/tmp/old', '--path', '/tmp/new']);
    assert.deepEqual(result, { cwd: '/tmp/new', args: [] });
  });

  test('--path wins over --cwd when both present (--path first)', () => {
    const result = extractCwd(['--path', '/tmp/new', '--cwd', '/tmp/old']);
    assert.deepEqual(result, { cwd: '/tmp/new', args: [] });
  });

  test('neither flag falls back to defaultCwd', () => {
    const result = extractCwd([], '/default');
    assert.deepEqual(result, { cwd: '/default', args: [] });
  });

  test('empty-string value ignored, falls back to defaultCwd', () => {
    const result = extractCwd(['--cwd', ''], '/default');
    assert.deepEqual(result, { cwd: '/default', args: ['--cwd', ''] });
  });

  test('extra args pass through cleanly', () => {
    const result = extractCwd(['--path', '/tmp/proj', '--dry-run']);
    assert.deepEqual(result, { cwd: '/tmp/proj', args: ['--dry-run'] });
  });

  test('extra args with --cwd pass through cleanly', () => {
    const result = extractCwd(['--cwd', '/tmp/proj', '--verbose']);
    assert.deepEqual(result, { cwd: '/tmp/proj', args: ['--verbose'] });
  });
});

describe('getPositionalArgs', () => {
  test('--path value not leaked as positional', () => {
    const result = getPositionalArgs(['--path', '/tmp/proj', 'push']);
    assert.deepEqual(result, ['push']);
  });

  test('--cwd value still not leaked as positional (regression)', () => {
    const result = getPositionalArgs(['--cwd', '/tmp/proj', 'push']);
    assert.deepEqual(result, ['push']);
  });
});
