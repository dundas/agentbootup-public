import { describe, expect, test } from 'bun:test';
import { decodeAndValidateBrainId } from '../lib/brain-id';
import { HttpError } from '../errors';

describe('decodeAndValidateBrainId', () => {
  test('accepts valid identifiers', () => {
    expect(decodeAndValidateBrainId('brain-1_ok')).toBe('brain-1_ok');
  });

  test('accepts dot-separated agent IDs', () => {
    expect(decodeAndValidateBrainId('mech-browse.gm')).toBe('mech-browse.gm');
    expect(decodeAndValidateBrainId('decisive.gm')).toBe('decisive.gm');
    expect(decodeAndValidateBrainId('a.b.c')).toBe('a.b.c');
  });

  test('rejects dots at boundaries or consecutive', () => {
    expect(() => decodeAndValidateBrainId('.leading')).toThrow(HttpError);
    expect(() => decodeAndValidateBrainId('trailing.')).toThrow(HttpError);
    expect(() => decodeAndValidateBrainId('foo..bar')).toThrow(HttpError);
    expect(() => decodeAndValidateBrainId('.')).toThrow(HttpError);
    expect(() => decodeAndValidateBrainId('..')).toThrow(HttpError);
  });

  test('rejects invalid URL encoding', () => {
    expect(() => decodeAndValidateBrainId('%E0%A4%A')).toThrow(HttpError);
  });

  test('rejects unsupported characters', () => {
    expect(() => decodeAndValidateBrainId('bad/id')).toThrow(HttpError);
    expect(() => decodeAndValidateBrainId('bad space')).toThrow(HttpError);
    expect(() => decodeAndValidateBrainId('brain%3Aalpha')).toThrow(HttpError);
  });

  test('rejects too-long identifiers', () => {
    expect(() => decodeAndValidateBrainId('a'.repeat(129))).toThrow(HttpError);
    expect(decodeAndValidateBrainId('a'.repeat(128))).toBe('a'.repeat(128));
  });
});
