import { test, expect, describe } from 'bun:test';
import { isValidBrainId, MAX_BRAIN_ID_LENGTH } from '../../lib/config/brain-id.js';

describe('isValidBrainId', () => {
  describe('valid IDs', () => {
    test('simple single segment', () => expect(isValidBrainId('alice')).toBe(true));
    test('dot-separated segments', () => expect(isValidBrainId('decisive.gm')).toBe(true));
    test('multiple segments', () => expect(isValidBrainId('a.b.c')).toBe(true));
    test('with underscores', () => expect(isValidBrainId('my_brain.gm')).toBe(true));
    test('with hyphens in middle', () => expect(isValidBrainId('my-brain.dev')).toBe(true));
    test('length exactly 128', () => {
      const id = 'a'.repeat(128);
      expect(isValidBrainId(id)).toBe(true);
    });
    test('uppercase letters', () => expect(isValidBrainId('Brain.GM')).toBe(true));
    test('digits', () => expect(isValidBrainId('brain1.gm2')).toBe(true));
  });

  describe('invalid IDs', () => {
    test('empty string', () => expect(isValidBrainId('')).toBe(false));
    test('null', () => expect(isValidBrainId(null as any)).toBe(false));
    test('undefined', () => expect(isValidBrainId(undefined as any)).toBe(false));
    test('number', () => expect(isValidBrainId(42 as any)).toBe(false));
    test('length 129 (too long)', () => {
      const id = 'a'.repeat(129);
      expect(isValidBrainId(id)).toBe(false);
    });
    test('leading hyphen in segment', () => expect(isValidBrainId('-brain.gm')).toBe(false));
    test('trailing hyphen in segment', () => expect(isValidBrainId('brain-.gm')).toBe(false));
    test('leading hyphen after dot', () => expect(isValidBrainId('brain.-gm')).toBe(false));
    test('only dots', () => expect(isValidBrainId('...')).toBe(false));
    test('trailing dot', () => expect(isValidBrainId('brain.')).toBe(false));
    test('leading dot', () => expect(isValidBrainId('.brain')).toBe(false));
    test('spaces', () => expect(isValidBrainId('brain gm')).toBe(false));
    test('at symbol', () => expect(isValidBrainId('brain@gm')).toBe(false));
    test('slash', () => expect(isValidBrainId('brain/gm')).toBe(false));
  });

  test('MAX_BRAIN_ID_LENGTH is 128', () => {
    expect(MAX_BRAIN_ID_LENGTH).toBe(128);
  });
});
