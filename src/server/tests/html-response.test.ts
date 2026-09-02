import { describe, expect, test } from 'bun:test';
import { htmlPage } from '../lib/html-response';

describe('html-response', () => {
  test('htmlPage sets baseline security headers', async () => {
    const res = htmlPage('Keys', '<p>ok</p>');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
  });

  test('htmlPage permits only its nonce-bound script and same-origin connections when requested', () => {
    const res = htmlPage('Auth', '<script nonce="nonce-value">void 0</script>', { scriptNonce: 'nonce-value' });
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-nonce-value'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
  });
});
