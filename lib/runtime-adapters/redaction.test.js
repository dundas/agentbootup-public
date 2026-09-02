import { describe, expect, test } from 'bun:test';
import { redactContent, redactViolations } from './redaction.js';

describe('redactViolations', () => {
  test('redacts arrays and whole string values when detector supplies paths only', () => {
    const value = { messages: [{ output: 'prefix synthetic-token suffix' }], headers: [['Authorization', 'Bearer synthetic-token']] };
    const result = redactViolations(value, ['$.messages[0].output', '$.headers[0][1]']);
    expect(result.value.messages[0].output).toBe('REDACTED_HEURISTIC');
    expect(result.value.headers[0][1]).toBe('REDACTED_HEURISTIC');
    expect(result.replacements).toBe(2);
  });

  test('deduplicates collisions and skips invalid or dangerous paths with path-only warnings', () => {
    const warnings = [];
    const value = { safe: { value: 'synthetic-token' } };
    const result = redactViolations(value, [
      '$.safe.value', '$.safe.value', '$.missing.value', '$.__proto__.polluted', 'not-a-path',
    ], { warn: (warning) => warnings.push(warning) });
    expect(result.replacements).toBe(1);
    expect(result.invalidPaths).toEqual(['$.missing.value', '$.__proto__.polluted', 'not-a-path']);
    expect(warnings.every((warning) => Object.keys(warning).sort().join(',') === 'code,path')).toBe(true);
    expect({}.polluted).toBeUndefined();
  });
});

describe('redactContent JSONL', () => {
  test('redacts exact and heuristic values with category labels', () => {
    const secret = 'synthetic/env?secret';
    const input = `${JSON.stringify({ message: { content: `prefix ${secret} suffix` } })}\n` +
      `${JSON.stringify({ token: 'unlisted-opaque-credential' })}\n`;
    const result = redactContent(input, {
      format: 'jsonl', denylist: new Set([secret]), sourceMap: new Map([[secret, 'env']]),
    });
    expect(result.blocked).toBe(false);
    expect(result.cleanContent).not.toContain(secret);
    expect(result.cleanContent).toContain('REDACTED_ENV');
    expect(result.cleanContent).toContain('REDACTED_HEURISTIC');
    expect(result.replacements).toBe(1);
    expect(result.heuristicHits).toBe(1);
  });

  test('preserves clean lines byte-identically and reserializes only changed lines', () => {
    const clean = '{ "big": 900719925474099312345, "duplicate": 1, "duplicate": 2 }';
    const changed = '{ "message": "synthetic-long-secret" }';
    const result = redactContent(`${clean}\n${changed}\n`, {
      format: 'jsonl', denylist: new Set(['synthetic-long-secret']),
      sourceMap: new Map([['synthetic-long-secret', 'denylist']]),
    });
    const lines = result.cleanContent.split('\n');
    expect(lines[0]).toBe(clean);
    expect(lines[1]).toBe('{"message":"REDACTED_DENYLIST"}');
  });

  test('blocks a suspicious malformed line even after exact replacement', () => {
    const secret = 'synthetic-malformed-secret';
    const result = redactContent(`{"message":"${secret}"`, {
      format: 'jsonl', denylist: new Set([secret]),
    });
    expect(result.blocked).toBe(true);
    expect(result.blockReason).toBe('redaction_malformed_jsonl_suspicious');
    expect(result.cleanContent).not.toContain(secret);
  });

  test('allows malformed JSONL with no secret signal byte-identically', () => {
    const input = '{"ordinary":"unfinished"';
    const result = redactContent(input, { format: 'jsonl', denylist: new Set() });
    expect(result).toEqual({ cleanContent: input, replacements: 0, heuristicHits: 0, blocked: false, blockReason: null });
  });

  test('redacts stringified JSON nested inside a string', () => {
    const secret = 'synthetic-nested-secret';
    const input = `${JSON.stringify({ payload: JSON.stringify({ api_key: secret }) })}\n`;
    const result = redactContent(input, { format: 'jsonl', denylist: new Set([secret]) });
    expect(result.blocked).toBe(false);
    expect(result.cleanContent).not.toContain(secret);
    expect(result.cleanContent).toContain('REDACTED');

    const heuristic = redactContent(`${JSON.stringify({ payload: JSON.stringify({ api_key: 'unlisted-opaque-value' }) })}\n`, {
      format: 'jsonl', denylist: new Set(),
    });
    expect(heuristic.blocked).toBe(false);
    expect(heuristic.cleanContent).not.toContain('unlisted-opaque-value');
    expect(heuristic.cleanContent).toContain('REDACTED_HEURISTIC');
    expect(heuristic.heuristicHits).toBe(1);

    const doubleNestedInput = `${JSON.stringify({
      payload: JSON.stringify({ inner: JSON.stringify({ api_key: 'double-nested-opaque-value' }) }),
    })}\n`;
    const doubleNested = redactContent(doubleNestedInput, { format: 'jsonl', denylist: new Set() });
    expect(doubleNested.blocked).toBe(false);
    const outer = JSON.parse(doubleNested.cleanContent);
    const middle = JSON.parse(outer.payload);
    const inner = JSON.parse(middle.inner);
    expect(inner.api_key).toBe('REDACTED_HEURISTIC');
    expect(doubleNested.heuristicHits).toBe(1);
  });

  test('uses one longest-first replacement pass without rescanning replacement output', () => {
    const short = 'synthetic-secret';
    const long = 'synthetic-secret-with-tail';
    const input = `${JSON.stringify({ text: `${long} ${short}` })}\n`;
    const result = redactContent(input, { format: 'jsonl', denylist: new Set([short, long]) });
    expect(result.blocked).toBe(false);
    expect(result.cleanContent).toBe('{"text":"REDACTED REDACTED"}\n');
    expect(result.replacements).toBe(2);
  });

  test('exact matching preserves UTF-16 semantics for non-BMP denylist values', () => {
    const value = 'synthetic-emoji-🔐-credential';
    const result = redactContent(`${value}\n`, { format: 'text', denylist: new Set([value]) });
    expect(result.blocked).toBe(false);
    expect(result.replacements).toBe(1);
    expect(result.cleanContent).not.toContain(value);
  });

  test('uses a non-colliding recognized placeholder when a denylist value overlaps a label', () => {
    const result = redactContent('{"text":"REDACTED"}\n', {
      format: 'jsonl', denylist: new Set(['REDACTED']),
    });
    expect(result.blocked).toBe(false);
    expect(result.cleanContent).toBe('{"text":"[redacted]"}\n');
  });

  test('replacement labels are constant length regardless of secret length', () => {
    const first = redactContent('{"text":"synthetic-secret-one"}\n', {
      format: 'jsonl', denylist: new Set(['synthetic-secret-one']), sourceMap: new Map([['synthetic-secret-one', 'env']]),
    });
    const second = redactContent('{"text":"synthetic-much-longer-secret-value-two"}\n', {
      format: 'jsonl', denylist: new Set(['synthetic-much-longer-secret-value-two']), sourceMap: new Map([['synthetic-much-longer-secret-value-two', 'env']]),
    });
    expect(first.blocked).toBe(false);
    expect(second.blocked).toBe(false);
    expect(first.cleanContent).toBe('{"text":"REDACTED_ENV"}\n');
    expect(second.cleanContent).toBe('{"text":"REDACTED_ENV"}\n');
  });

  test('accepts loaded and empty-by-config states but blocks failed loader state', () => {
    const loaded = redactContent('{"text":"synthetic-loaded-secret"}\n', {
      format: 'jsonl', denylist: { state: 'loaded', values: new Set(['synthetic-loaded-secret']) },
    });
    const empty = redactContent('{"text":"ordinary"}\n', {
      format: 'jsonl', denylist: { state: 'empty-by-config', values: new Set() },
    });
    const failed = redactContent('{"text":"ordinary"}\n', {
      format: 'jsonl', denylist: { state: 'failed', values: new Set() },
    });
    expect(loaded.blocked).toBe(false);
    expect(empty).toEqual({ cleanContent: '{"text":"ordinary"}\n', replacements: 0, heuristicHits: 0, blocked: false, blockReason: null });
    expect(failed).toMatchObject({ blocked: true, blockReason: 'redaction_denylist_failed' });
  });

  test('redacts derived variants with their source category', () => {
    const derived = 'synthetic%2Fderived%3Fvalue';
    const result = redactContent(`${JSON.stringify({ text: derived })}\n`, {
      format: 'jsonl', denylist: new Set(), derivedDenylist: new Set([derived]),
      derivedSourceMap: new Map([[derived, 'denylist']]),
    });
    expect(result).toMatchObject({ blocked: false, replacements: 1 });
    expect(result.cleanContent).toBe('{"text":"REDACTED_DENYLIST"}\n');
  });

  test('redacts detector root path for JSONL scalar strings', () => {
    const categories = [];
    const result = redactContent('"Bearer synthetic-root-token"\n', {
      format: 'jsonl', denylist: new Set(), onReplacement: (category) => categories.push(category),
    });
    expect(result.blocked).toBe(false);
    expect(result.cleanContent).toBe('"REDACTED_HEURISTIC"\n');
    expect(result.heuristicHits).toBe(1);
    expect(categories).toEqual(['heuristic']);
  });

  test('propagates unexpected redaction exceptions for subsystem-level fail closed', () => {
    expect(() => redactContent('{"api.key":"synthetic-unlisted-secret"}\n', {
      format: 'jsonl', denylist: new Set(), warn: () => { throw new Error('synthetic warning sink failure'); },
    })).toThrow('synthetic warning sink failure');

    const nestedSecret = 'synthetic"nested-secret';
    const nestedInput = `${JSON.stringify({ payload: JSON.stringify({ text: nestedSecret }) })}\n`;
    expect(() => redactContent(nestedInput, {
      format: 'jsonl', denylist: new Set([nestedSecret]),
      sourceMap: { get() { throw new Error('synthetic nested lookup failure'); } },
    })).toThrow('synthetic nested lookup failure');
  });

  test('fails closed when punctuation makes a nested detector path unaddressable', () => {
    const secret = 'punctuation-key-opaque-value';
    const warnings = [];
    const single = redactContent(`${JSON.stringify({ payload: JSON.stringify({ 'api.key': secret }) })}\n`, {
      format: 'jsonl', denylist: new Set(), warn: (warning) => warnings.push(warning),
    });
    expect(single).toMatchObject({ blocked: true, blockReason: 'redaction_cannot_prove_scrubbed' });
    expect(warnings).toEqual([{ code: 'invalid_redaction_path', path: '$.api.key' }]);

    warnings.length = 0;
    const double = redactContent(`${JSON.stringify({
      payload: JSON.stringify({ inner: JSON.stringify({ 'secret.key': secret }) }),
    })}\n`, { format: 'jsonl', denylist: new Set(), warn: (warning) => warnings.push(warning) });
    expect(double).toMatchObject({ blocked: true, blockReason: 'redaction_cannot_prove_scrubbed' });
    expect(warnings).toEqual([{ code: 'invalid_redaction_path', path: '$.secret.key' }]);
  });
});

describe('redactContent raw text', () => {
  test('redacts exact values, token patterns, and secret-key lines then verifies output', () => {
    const secret = 'synthetic-explicit-value';
    const input = `ordinary ${secret}\nsk-proj-abcdefghijklmnopqrstuvwxyz123456\napi_key: synthetic-unlisted-value\n`;
    const result = redactContent(input, { format: 'text', denylist: new Set([secret]) });
    expect(result.blocked).toBe(false);
    expect(result.cleanContent).not.toContain(secret);
    expect(result.cleanContent).not.toContain('sk-proj-');
    expect(result.cleanContent).not.toContain('synthetic-unlisted-value');
    expect(result.heuristicHits).toBe(2);
  });

  test('blocks when a private-key marker makes complete scrubbing unprovable', () => {
    const result = redactContent('-----BEGIN PRIVATE KEY-----\nopaque-body\n', { format: 'text', denylist: new Set() });
    expect(result.blocked).toBe(true);
    expect(result.blockReason).toBe('redaction_cannot_prove_scrubbed');
  });

  test('empty denylist is a byte-identical passthrough when heuristics find nothing', () => {
    const input = 'ordinary transcript text\n';
    expect(redactContent(input, { format: 'text', denylist: new Set() }))
      .toEqual({ cleanContent: input, replacements: 0, heuristicHits: 0, blocked: false, blockReason: null });
  });

  test('unsupported formats fail closed', () => {
    expect(redactContent('ordinary', { format: 'binary', denylist: new Set() }))
      .toMatchObject({ blocked: true, blockReason: 'redaction_unsupported_format' });
  });
});

describe('redactContent full JSON', () => {
  test('redacts pretty multiline JSON as one document and reports non-secret categories', () => {
    const envSecret = 'synthetic-pretty-env-secret';
    const retiredSecret = 'synthetic-pretty-retired-secret';
    const categories = [];
    const input = JSON.stringify({
      message: `prefix ${envSecret}`,
      nested: { value: retiredSecret, api_key: 'synthetic-unlisted-pretty-secret' },
    }, null, 2) + '\n';
    const result = redactContent(input, {
      format: 'json',
      denylist: new Set([envSecret, retiredSecret]),
      sourceMap: new Map([[envSecret, 'env'], [retiredSecret, 'denylist']]),
      onReplacement: (category) => categories.push(category),
    });
    expect(result.blocked).toBe(false);
    expect(result.cleanContent).not.toContain(envSecret);
    expect(result.cleanContent).not.toContain(retiredSecret);
    expect(JSON.parse(result.cleanContent).nested.api_key).toBe('REDACTED_HEURISTIC');
    expect(categories.sort()).toEqual(['denylist', 'env', 'heuristic']);
  });

  test('preserves a clean full JSON document byte-identically', () => {
    const input = '{\n  "ordinary": 1\n}\n';
    expect(redactContent(input, { format: 'json', denylist: new Set() }).cleanContent).toBe(input);
  });

  test('fails closed for suspicious malformed full JSON', () => {
    const result = redactContent('{\n  "token": "synthetic-unlisted-secret"', {
      format: 'json', denylist: new Set(),
    });
    expect(result).toMatchObject({ blocked: true, blockReason: 'redaction_malformed_json_suspicious' });
  });
});
