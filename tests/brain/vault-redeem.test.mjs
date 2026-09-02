import { test, expect, describe } from 'bun:test';
import {
  parseVaultRef,
  httpRedeemTransport,
  redeemSecret,
  buildInjectedEnv,
  VaultUnreachableError,
} from '../../lib/brain/vault-redeem.js';

describe('parseVaultRef', () => {
  test('accepts vault://<namespace>/<name>', () => {
    expect(parseVaultRef('vault://brain-a/agentdrive')).toEqual({ namespace: 'brain-a', name: 'agentdrive' });
  });

  test('rejects non-vault scheme', () => {
    expect(() => parseVaultRef('https://x/y')).toThrow(/expected 'vault:/);
    expect(() => parseVaultRef('brain-a/agentdrive')).toThrow(/expected 'vault:/);
  });

  test('rejects wrong segment count', () => {
    expect(() => parseVaultRef('vault://only-one')).toThrow(/exactly <namespace>\/<name>/);
    expect(() => parseVaultRef('vault://a/b/c')).toThrow(/exactly/);
  });

  test('rejects traversal-shaped segments', () => {
    expect(() => parseVaultRef('vault://../agentdrive')).toThrow(/must match/);
    expect(() => parseVaultRef('vault://brain-a/..')).toThrow(/must match/);
    expect(() => parseVaultRef('vault://brain.a/x')).toThrow(/must match/); // dot not allowed
  });
});

describe('httpRedeemTransport', () => {
  test('GETs the redeem path and returns the env map', async () => {
    let calledUrl = null;
    const fetch = async (url) => {
      calledUrl = url;
      return { ok: true, status: 200, json: async () => ({ AGENTDRIVE_KEY: 'sk-test' }) };
    };
    const transport = httpRedeemTransport({ vaultBaseUrl: 'https://vault.example/', fetch });
    const secrets = await transport({ namespace: 'brain-a', name: 'agentdrive' });
    expect(calledUrl).toBe('https://vault.example/api/redeem/brain-a/agentdrive');
    expect(secrets).toEqual({ AGENTDRIVE_KEY: 'sk-test' });
  });

  test('4xx response → plain Error (vault ANSWERED + rejected → proven-bad, fail-closed)', async () => {
    const fetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
    const transport = httpRedeemTransport({ vaultBaseUrl: 'https://vault.example', fetch });
    await expect(transport({ namespace: 'b', name: 'n' })).rejects.toThrow(/HTTP 403/);
    // A 4xx is NOT unreachable — it must not degrade the credentials check to unknown.
    const err = await transport({ namespace: 'b', name: 'n' }).catch((e) => e);
    expect(err).not.toBeInstanceOf(VaultUnreachableError);
  });

  // PRD-0039 FR-3: distinguish vault-unreachable (→ unknown) from vault-rejected (→ fail).
  test('5xx response → VaultUnreachableError (vault reachable-but-broken/absent)', async () => {
    const fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const transport = httpRedeemTransport({ vaultBaseUrl: 'https://vault.example', fetch });
    const err = await transport({ namespace: 'b', name: 'n' }).catch((e) => e);
    expect(err).toBeInstanceOf(VaultUnreachableError);
    expect(err.message).toMatch(/unreachable.*HTTP 503/);
  });

  test('transient 4xx (429 rate-limit, 408 timeout, 425 too-early) → VaultUnreachableError (not a false-Stuck)', async () => {
    for (const status of [408, 425, 429]) {
      const transport = httpRedeemTransport({ vaultBaseUrl: 'https://v', fetch: async () => ({ ok: false, status, json: async () => ({}) }) });
      const err = await transport({ namespace: 'b', name: 'n' }).catch((e) => e);
      expect(err).toBeInstanceOf(VaultUnreachableError);
    }
    // ...but a non-transient 4xx (401/403/404) stays a proven fail.
    for (const status of [401, 403, 404]) {
      const transport = httpRedeemTransport({ vaultBaseUrl: 'https://v', fetch: async () => ({ ok: false, status, json: async () => ({}) }) });
      const err = await transport({ namespace: 'b', name: 'n' }).catch((e) => e);
      expect(err).not.toBeInstanceOf(VaultUnreachableError);
    }
  });

  test('transport-level network rejection (connection refused / timeout) → VaultUnreachableError', async () => {
    const fetch = async () => { throw new Error('ECONNREFUSED'); };
    const transport = httpRedeemTransport({ vaultBaseUrl: 'https://vault.example', fetch });
    const err = await transport({ namespace: 'b', name: 'n' }).catch((e) => e);
    expect(err).toBeInstanceOf(VaultUnreachableError);
    expect(err.message).toMatch(/unreachable.*ECONNREFUSED/);
    expect(err.cause).toBeInstanceOf(Error); // original cause preserved
  });

  test('requires vaultBaseUrl', () => {
    expect(() => httpRedeemTransport({})).toThrow(/vaultBaseUrl/);
  });

  test('passes a bounded AbortSignal to fetch (hung vault fails closed)', async () => {
    let sawSignal = false;
    const fetch = async (_url, opts) => {
      sawSignal = opts?.signal instanceof AbortSignal;
      return { ok: true, status: 200, json: async () => ({ K: 'v' }) };
    };
    const transport = httpRedeemTransport({ vaultBaseUrl: 'https://v', fetch, timeoutMs: 50 });
    await transport({ namespace: 'a', name: 'b' });
    expect(sawSignal).toBe(true);
  });

  test('re-validates segments (defense-in-depth against direct calls)', async () => {
    const transport = httpRedeemTransport({ vaultBaseUrl: 'https://v', fetch: async () => ({ ok: true, status: 200, json: async () => ({ K: 'v' }) }) });
    await expect(transport({ namespace: '..', name: 'b' })).rejects.toThrow(/invalid segment/);
  });

  test('throws on a non-JSON 200 response (fail-closed)', async () => {
    const fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } });
    const transport = httpRedeemTransport({ vaultBaseUrl: 'https://vault.example', fetch });
    await expect(transport({ namespace: 'a', name: 'b' })).rejects.toThrow(/not valid JSON/);
  });

  test('throws on an empty/array body used directly (transport-level fail-closed)', async () => {
    const empty = httpRedeemTransport({ vaultBaseUrl: 'https://v', fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
    await expect(empty({ namespace: 'a', name: 'b' })).rejects.toThrow(/no usable secret material/);
    const arr = httpRedeemTransport({ vaultBaseUrl: 'https://v', fetch: async () => ({ ok: true, status: 200, json: async () => [] }) });
    await expect(arr({ namespace: 'a', name: 'b' })).rejects.toThrow(/no usable secret material/);
  });
});

describe('redeemSecret', () => {
  test('requires a transport (no implicit default — fail loud)', async () => {
    await expect(redeemSecret('vault://a/b', {})).rejects.toThrow(/requires a transport/);
  });

  test('parses ref then returns transport secrets', async () => {
    const transport = async ({ namespace, name }) => ({ K: `${namespace}:${name}` });
    expect(await redeemSecret('vault://brain-a/agentdrive', { transport })).toEqual({ K: 'brain-a:agentdrive' });
  });

  test('rejects an invalid ref before calling transport', async () => {
    let called = false;
    const transport = async () => { called = true; return {}; };
    await expect(redeemSecret('vault://../x', { transport })).rejects.toThrow(/must match/);
    expect(called).toBe(false);
  });

  test('rejects non-object secret material', async () => {
    await expect(redeemSecret('vault://a/b', { transport: async () => 'nope' })).rejects.toThrow(/no usable secret/);
  });

  test('rejects an EMPTY redeem result (adversarial: false-green on nothing-redeemed)', async () => {
    await expect(redeemSecret('vault://a/b', { transport: async () => ({}) })).rejects.toThrow(/no usable secret material/);
  });
});

describe('buildInjectedEnv', () => {
  test('returns a frozen copy', () => {
    const env = buildInjectedEnv({ A: '1' });
    expect(env).toEqual({ A: '1' });
    expect(Object.isFrozen(env)).toBe(true);
  });

  test('rejects non-object input', () => {
    expect(() => buildInjectedEnv(null)).toThrow(/secret map object/);
    expect(() => buildInjectedEnv(['a'])).toThrow(/secret map object/);
  });

  test('rejects non-string values (would stringify to [object Object] in env)', () => {
    expect(() => buildInjectedEnv({ KEY: { nested: true } })).toThrow(/value for "KEY" is not a string/);
    expect(() => buildInjectedEnv({ KEY: 42 })).toThrow(/not a string/);
  });
});
