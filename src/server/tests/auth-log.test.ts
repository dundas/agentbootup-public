import { describe, test, expect } from 'bun:test';
import { authFailureEvent } from '../lib/auth-log';

describe('authFailureEvent', () => {
  test('maps auth failure statuses to log labels', () => {
    expect(authFailureEvent(401)).toBe('auth_failed');
    expect(authFailureEvent(403)).toBe('auth_forbidden');
    expect(authFailureEvent(429)).toBe('rate_limited');
  });
});
