import { expect, test } from 'bun:test';
import { createAnalysisPrivacyPolicy } from '../lib/analysis/privacy-policy.js';
import { ANALYSIS_PRIVACY_LIMITS, createVerifiedAnalysisProjection, sendVerifiedAnalysisProjection } from '../lib/analysis/privacy-boundary.js';

const canary = 'AGENTBOOTUP_ANALYSIS_BOUNDARY_CANARY_5d9e1a';
const policy = () => createAnalysisPrivacyPolicy([], {
  snapshot: {
    state: 'loaded', values: new Set([canary]), sourceMap: new Map([[canary, 'env']]),
    derivedValues: new Set(), derivedSourceMap: new Map(), health: {},
  },
});

const raw = (content = 'ordinary implementation note') => ({
  cli: 'codex', cwd: '/private/path', gitBranch: 'private-branch', sessionId: 'private-session-id',
  messages: [{ type: 'user', content }], toolUses: [{ tool: 'Bash', parameters: { secret: canary } }],
  errors: [{ message: canary }], summary: { messageCount: 12, durationMs: 60_000 },
});

test('projection is frozen, allowlisted, and excludes raw metadata', () => {
  const projection = createVerifiedAnalysisProjection(raw(), policy());

  expect(Object.isFrozen(projection)).toBe(true);
  expect(Object.keys(projection).sort()).toEqual(['cli', 'durationMs', 'errorCategory', 'messageCount', 'messages', 'toolCategory']);
  expect(JSON.stringify(projection)).not.toContain('/private/path');
  expect(JSON.stringify(projection)).not.toContain('private-session-id');
  expect(JSON.stringify(projection)).not.toContain(canary);
});

test('blocked input makes zero transport requests', async () => {
  let calls = 0;
  const projection = createVerifiedAnalysisProjection(raw('-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----'), policy());
  const result = await sendVerifiedAnalysisProjection(projection, policy(), {
    appId: 'test-app', apiKey: 'test-key', fetchImpl: async () => { calls++; throw new Error('must not send'); },
  });

  expect(result).toEqual({ state: 'blocked_redaction', code: 'analysis_projection_unverified' });
  expect(calls).toBe(0);
});

test('an unavailable policy blocks message-less transcripts before transport', async () => {
  let calls = 0;
  const unavailablePolicy = createAnalysisPrivacyPolicy([], { snapshot: { state: 'failed', health: {} } });
  const projection = createVerifiedAnalysisProjection({ cli: 'codex', messages: [], summary: { messageCount: 12, durationMs: 60_000 } }, unavailablePolicy);
  expect(projection).toEqual({ state: 'blocked_redaction', code: 'analysis_policy_unavailable' });
  const result = await sendVerifiedAnalysisProjection(projection, unavailablePolicy, {
    appId: 'test-app', apiKey: 'test-key', fetchImpl: async () => { calls++; },
  });
  expect(result).toEqual({ state: 'blocked_redaction', code: 'analysis_projection_unverified' });
  expect(calls).toBe(0);
});

test('sanitizes the full local message before applying prompt truncation', () => {
  const canaryPrefix = canary.slice(0, 20);
  const content = `${'x'.repeat(ANALYSIS_PRIVACY_LIMITS.maxMessageCharacters - canaryPrefix.length)}${canary}`;
  expect(content.indexOf(canary)).toBe(ANALYSIS_PRIVACY_LIMITS.maxMessageCharacters - canaryPrefix.length);

  const projection = createVerifiedAnalysisProjection(raw(content), policy());

  expect(projection.messages[0]).not.toContain(canary);
  expect(projection.messages[0]).not.toContain(canaryPrefix);
  expect(projection.messages[0].length).toBeLessThanOrEqual(ANALYSIS_PRIVACY_LIMITS.maxMessageCharacters);
});

test('verified request contains no raw canary, path, session ID, tool payload, or error text', async () => {
  const captured = [];
  const projection = createVerifiedAnalysisProjection(raw(), policy());
  const response = await sendVerifiedAnalysisProjection(projection, policy(), {
    appId: 'test-app', apiKey: 'test-key', mechUrl: 'https://loopback.invalid',
    fetchImpl: async (url, init) => {
      captured.push({ url, headers: init.headers, body: init.body });
      return new Response(JSON.stringify({ completion: '{}' }), { status: 200 });
    },
  });
  const serialized = JSON.stringify(captured);

  expect(response).toEqual({ completion: '{}' });
  expect(captured).toHaveLength(1);
  expect(Buffer.byteLength(captured[0].body, 'utf8')).toBeLessThanOrEqual(ANALYSIS_PRIVACY_LIMITS.maxRequestBytes);
  for (const forbidden of [canary, '/private/path', 'private-session-id', 'private-branch']) {
    expect(serialized).not.toContain(forbidden);
  }
});

test('forged projections are rejected before transport', async () => {
  let calls = 0;
  const result = await sendVerifiedAnalysisProjection(Object.freeze({ cli: 'codex', messages: Object.freeze([]) }), policy(), {
    appId: 'test-app', apiKey: 'test-key', fetchImpl: async () => { calls++; },
  });

  expect(result).toEqual({ state: 'blocked_redaction', code: 'analysis_projection_unverified' });
  expect(calls).toBe(0);
});

test('transport failures are surfaced with a stable non-secret error', async () => {
  const projection = createVerifiedAnalysisProjection(raw('clean request'), policy());
  await expect(sendVerifiedAnalysisProjection(projection, policy(), {
    appId: 'test-app', apiKey: 'test-key', fetchImpl: async () => { throw new Error('/private/provider-detail'); },
  })).rejects.toMatchObject({ code: 'MECH_LLM_TRANSPORT_FAILED', message: 'Mech LLMs request failed.' });
});

test('only the designated privacy boundary imports the generic LLM client', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const entries = await readdir(new URL('../lib/analysis/', import.meta.url), { withFileTypes: true });
  const importers = [];
  for (const entry of entries.filter((entry) => entry.isFile() && entry.name.endsWith('.js'))) {
    const source = await readFile(new URL(`../lib/analysis/${entry.name}`, import.meta.url), 'utf8');
    if (source.includes("./mech-llms-client.js")) importers.push(entry.name);
  }
  expect(importers).toEqual(['privacy-boundary.js']);
});
