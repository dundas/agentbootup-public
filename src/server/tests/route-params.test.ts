import { describe, expect, test } from 'bun:test';
import { HttpError } from '../errors';
import { decodeAndValidateIdentifier } from '../lib/route-params';

describe('decodeAndValidateIdentifier', () => {
  test('accepts valid identifiers', () => {
    expect(decodeAndValidateIdentifier('alpha-1_ok', 'testId', 200)).toBe('alpha-1_ok');
    expect(decodeAndValidateIdentifier('service%3Acore', 'serviceId', 200)).toBe('service:core');
  });

  test('rejects malformed URL encoding', () => {
    expect(() => decodeAndValidateIdentifier('%E0%A4%A', 'xId', 200)).toThrow(HttpError);
  });

  test('rejects unsupported identifier characters', () => {
    expect(() => decodeAndValidateIdentifier('bad/id', 'xId', 200)).toThrow(HttpError);
  });

  test('rejects identifiers longer than maxLength', () => {
    expect(() => decodeAndValidateIdentifier('a'.repeat(201), 'xId', 200)).toThrow(HttpError);
  });
});
