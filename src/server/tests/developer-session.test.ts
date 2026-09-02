import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import {
  resolveClearAuthSessionUser,
  sanitizeDeveloperReturnPath,
  type DeveloperSessionDeps,
} from '../lib/developer-session';

let priorNodeEnv: string | undefined;
let priorAllowTestSession: string | undefined;

beforeAll(() => {
  priorNodeEnv = process.env.NODE_ENV;
  priorAllowTestSession = process.env.AGENTBOOTUP_ALLOW_TEST_SESSION;
  process.env.NODE_ENV = 'test';
  process.env.AGENTBOOTUP_ALLOW_TEST_SESSION = '1';
});

afterAll(() => {
  if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = priorNodeEnv;

  if (priorAllowTestSession === undefined) delete process.env.AGENTBOOTUP_ALLOW_TEST_SESSION;
  else process.env.AGENTBOOTUP_ALLOW_TEST_SESSION = priorAllowTestSession;
});

describe('developer-session helpers', () => {
  test('sanitizeDeveloperReturnPath allows developer console paths only', () => {
    expect(sanitizeDeveloperReturnPath('/developer')).toBe('/developer');
    expect(sanitizeDeveloperReturnPath('/developer/keys')).toBe('/developer/keys');
    expect(sanitizeDeveloperReturnPath('/developer/device?code=ABCD')).toBe('/developer/device?code=ABCD');
    expect(sanitizeDeveloperReturnPath('/developer?x=%0d%0a')).toBe('/developer');
    expect(sanitizeDeveloperReturnPath('/?attacker=injected')).toBe('/developer');
    expect(sanitizeDeveloperReturnPath('//evil.example')).toBe('/developer');
    expect(sanitizeDeveloperReturnPath('/auth/callback')).toBe('/developer');
    expect(sanitizeDeveloperReturnPath('/developer-tools')).toBe('/developer');
    expect(sanitizeDeveloperReturnPath('/developer/../admin')).toBe('/developer');
    expect(sanitizeDeveloperReturnPath('/developer/%2e%2e/admin')).toBe('/developer');
    expect(sanitizeDeveloperReturnPath('/developer/%252e%252e/admin')).toBe('/developer');
    expect(sanitizeDeveloperReturnPath('/developer/%2F../settings')).toBe('/developer');
    expect(sanitizeDeveloperReturnPath('/developer/%5C../admin')).toBe('/developer');
    expect(sanitizeDeveloperReturnPath('/developer/%25252e%25252e/admin')).toBe('/developer');
    expect(sanitizeDeveloperReturnPath('/developer//secrets')).toBe('/developer');
    expect(sanitizeDeveloperReturnPath('/developer/%0d%0aInjected:%20x')).toBe('/developer');
    expect(sanitizeDeveloperReturnPath('/developer?x=1\r\nInjected: hdr')).toBe('/developer');
  });

  test('resolveClearAuthSessionUser ignores null testSessionUser and uses ClearAuth', async () => {
    let called = false;
    const result = await resolveClearAuthSessionUser(new Request('http://localhost'), {
      clearAuth: { getSessionUser: async () => { called = true; return null; } },
      externalUserStore: {} as DeveloperSessionDeps['externalUserStore'],
      testSessionUser: null,
    });
    expect(called).toBe(true);
    expect(result).toBeNull();
  });

  // Env-mutation tests use test.serial (requires Bun >= 1.0.29).
  test.serial('resolveClearAuthSessionUser returns testSessionUser when bypass is allowed', async () => {
    const priorAllow = process.env.AGENTBOOTUP_ALLOW_TEST_SESSION;
    const priorNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    process.env.AGENTBOOTUP_ALLOW_TEST_SESSION = '1';
    const user = { id: 'u_1', email: 'a@b.com' };
    try {
      const result = await resolveClearAuthSessionUser(new Request('http://localhost'), {
        clearAuth: { getSessionUser: async () => null },
        externalUserStore: {} as DeveloperSessionDeps['externalUserStore'],
        testSessionUser: user,
      });
      expect(result).toEqual(user);
    } finally {
      if (priorAllow === undefined) delete process.env.AGENTBOOTUP_ALLOW_TEST_SESSION;
      else process.env.AGENTBOOTUP_ALLOW_TEST_SESSION = priorAllow;
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorNodeEnv;
    }
  });

  test.serial('resolveClearAuthSessionUser rejects testSessionUser without explicit test opt-in', async () => {
    const priorAllow = process.env.AGENTBOOTUP_ALLOW_TEST_SESSION;
    const priorNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    delete process.env.AGENTBOOTUP_ALLOW_TEST_SESSION;
    const deps: DeveloperSessionDeps = {
      clearAuth: { getSessionUser: async () => null },
      externalUserStore: {} as DeveloperSessionDeps['externalUserStore'],
      testSessionUser: { id: 'u_test', email: 'test@example.com' },
    };
    try {
      await expect(resolveClearAuthSessionUser(new Request('http://localhost'), deps))
        .rejects.toThrow('internal configuration error');
    } finally {
      if (priorAllow === undefined) delete process.env.AGENTBOOTUP_ALLOW_TEST_SESSION;
      else process.env.AGENTBOOTUP_ALLOW_TEST_SESSION = priorAllow;
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorNodeEnv;
    }
  });

  test.serial('resolveClearAuthSessionUser rejects testSessionUser when NODE_ENV is not test', async () => {
    const priorAllow = process.env.AGENTBOOTUP_ALLOW_TEST_SESSION;
    const priorNodeEnv = process.env.NODE_ENV;
    process.env.AGENTBOOTUP_ALLOW_TEST_SESSION = '1';
    process.env.NODE_ENV = 'production';
    const deps: DeveloperSessionDeps = {
      clearAuth: { getSessionUser: async () => null },
      externalUserStore: {} as DeveloperSessionDeps['externalUserStore'],
      testSessionUser: { id: 'u_test', email: 'test@example.com' },
    };
    try {
      await expect(resolveClearAuthSessionUser(new Request('http://localhost'), deps))
        .rejects.toThrow('internal configuration error');
    } finally {
      if (priorAllow === undefined) delete process.env.AGENTBOOTUP_ALLOW_TEST_SESSION;
      else process.env.AGENTBOOTUP_ALLOW_TEST_SESSION = priorAllow;
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorNodeEnv;
    }
  });
});
