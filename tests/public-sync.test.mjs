import { describe, expect, test } from 'bun:test';
import { classifyFiles } from '../scripts/public-sync.mjs';

const policy = {
  include_roots: ['tests', 'secrets'],
  include_files: [],
  exclude_roots: ['secrets'],
  exclude_globs: ['**/.env'],
  exclude_exceptions: ['tests/fixture/.env'],
  required_files: [],
};

describe('public export exclusions', () => {
  test('permits only the exact audited glob exception and never a protected root', () => {
    const { selected, excluded } = classifyFiles([
      'tests/fixture/.env',
      'tests/fixture/unaudited/.env',
      'secrets/fixture/.env',
    ], policy);
    expect(selected).toEqual(['tests/fixture/.env']);
    expect(excluded).toEqual(['tests/fixture/unaudited/.env', 'secrets/fixture/.env']);
  });
});
