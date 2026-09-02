import { test, expect, describe } from 'bun:test';
import { validateToolsetConfig, ToolsetValidationError } from '../lib/toolsets';

describe('validateToolsetConfig (environment-scoped)', () => {
  test('undefined/null → undefined (toolsets optional)', () => {
    expect(validateToolsetConfig(undefined)).toBeUndefined();
    expect(validateToolsetConfig(null)).toBeUndefined();
  });

  test('accepts an environment-keyed policy map', () => {
    const cfg = validateToolsetConfig({
      circle_computer: { allowlist: ['read', 'chat'] },
      'mac-mini': { disabled_toolsets: ['web'] },
      'macbook-pro-5': { allowlist: ['bash', 'read', 'edit'], disabled_toolsets: ['deploy'] },
    });
    expect(cfg?.circle_computer.allowlist).toEqual(['read', 'chat']);
    expect(cfg?.['mac-mini'].disabled_toolsets).toEqual(['web']);
    expect(cfg?.['macbook-pro-5'].allowlist).toEqual(['bash', 'read', 'edit']);
  });

  test('rejects a non-object top level', () => {
    expect(() => validateToolsetConfig([])).toThrow(ToolsetValidationError);
    expect(() => validateToolsetConfig('x')).toThrow(ToolsetValidationError);
  });

  test('rejects an invalid environment id', () => {
    expect(() => validateToolsetConfig({ 'Bad Env!': { allowlist: ['x'] } })).toThrow(ToolsetValidationError);
  });

  test('rejects a non-object env policy', () => {
    expect(() => validateToolsetConfig({ 'mac-mini': ['x'] })).toThrow(ToolsetValidationError);
  });

  test('rejects unexpected keys within an env policy', () => {
    expect(() => validateToolsetConfig({ 'mac-mini': { allowlist: ['x'], unexpected: true } })).toThrow(ToolsetValidationError);
  });

  test('rejects a non-string-array allowlist', () => {
    expect(() => validateToolsetConfig({ 'mac-mini': { allowlist: [1, 2] } })).toThrow(ToolsetValidationError);
  });

  test('an environment may declare only a disabled list', () => {
    const cfg = validateToolsetConfig({ circle_computer: { disabled_toolsets: ['bash'] } });
    expect(cfg?.circle_computer.disabled_toolsets).toEqual(['bash']);
    expect(cfg?.circle_computer.allowlist).toBeUndefined();
  });
});
