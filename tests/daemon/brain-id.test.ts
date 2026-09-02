import { describe, expect, test } from 'bun:test';
import { isValidBrainId, MAX_BRAIN_ID_LENGTH } from '../../lib/config/brain-id.js';

describe('isValidBrainId', () => {
  test('accepts simple and dotted brain IDs', () => {
    expect(isValidBrainId('my-brain')).toBe(true);
    expect(isValidBrainId('mech-plane.gm')).toBe(true);
    expect(isValidBrainId('a.b.c')).toBe(true);
    expect(isValidBrainId('brain_01')).toBe(true);
  });

  test('rejects malformed or unsupported IDs', () => {
    expect(isValidBrainId(null)).toBe(false);
    expect(isValidBrainId(undefined)).toBe(false);
    expect(isValidBrainId('')).toBe(false);
    expect(isValidBrainId('.leading')).toBe(false);
    expect(isValidBrainId('trailing.')).toBe(false);
    expect(isValidBrainId('bad..brain')).toBe(false);
    expect(isValidBrainId('brain:v2')).toBe(false);
    expect(isValidBrainId('bad id')).toBe(false);
  });

  test('enforces max length', () => {
    expect(isValidBrainId('a'.repeat(MAX_BRAIN_ID_LENGTH))).toBe(true);
    expect(isValidBrainId('a'.repeat(MAX_BRAIN_ID_LENGTH + 1))).toBe(false);
  });
});
