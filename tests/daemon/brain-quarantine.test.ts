/**
 * Tests for lib/daemon/brain-quarantine.mjs — the shared identity-quarantine
 * module (PRD-0054 Slice A): 404 detection, startup handshake, in-memory
 * cooldown tracker. Red-first: written before the module exists.
 */

import { test, expect, afterEach } from 'bun:test';

const {
  isNotFoundBrainResponse,
  verifyBrainRegistered,
  createQuarantineTracker,
} = await import('../../lib/daemon/brain-quarantine.mjs');

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── isNotFoundBrainResponse ─────────────────────────────────────────────────

test('detects a registry 404 with error.code not_found', () => {
  const resp = new Response('', { status: 404 });
  expect(isNotFoundBrainResponse(resp, JSON.stringify({ error: { code: 'not_found' } }))).toBe(true);
});

test('rejects non-404 statuses and 404s without the not_found code', () => {
  expect(isNotFoundBrainResponse(new Response('', { status: 500 }), JSON.stringify({ error: { code: 'not_found' } }))).toBe(false);
  expect(isNotFoundBrainResponse(new Response('', { status: 404 }), 'plain html 404')).toBe(false);
  expect(isNotFoundBrainResponse(new Response('', { status: 404 }), JSON.stringify({ error: { code: 'other' } }))).toBe(false);
});

// ── verifyBrainRegistered ───────────────────────────────────────────────────

test('handshake reports registered on 200', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: { id: 'x.gm' } }), { status: 200 })) as typeof fetch;
  const result = await verifyBrainRegistered({ brainId: 'x.gm', apiKey: 'k', serverUrl: 'http://localhost:9999' });
  expect(result.outcome).toBe('registered');
});

test('handshake reports not_found on a registry 404', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 })) as typeof fetch;
  const result = await verifyBrainRegistered({ brainId: 'missing.gm', apiKey: 'k', serverUrl: 'http://localhost:9999' });
  expect(result.outcome).toBe('not_found');
});

test('handshake fails OPEN on 5xx and on network errors', async () => {
  globalThis.fetch = (async () => new Response('bad gateway', { status: 502 })) as typeof fetch;
  expect((await verifyBrainRegistered({ brainId: 'x.gm', apiKey: 'k', serverUrl: 'http://localhost:9999' })).outcome).toBe('unavailable');

  globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
  expect((await verifyBrainRegistered({ brainId: 'x.gm', apiKey: 'k', serverUrl: 'http://localhost:9999' })).outcome).toBe('unavailable');
});

test('handshake attaches a timeout signal so a dead server cannot hang startup', async () => {
  let capturedSignal: AbortSignal | undefined | null = null;
  globalThis.fetch = (async (_i: string | Request, init?: RequestInit) => {
    capturedSignal = init?.signal;
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }) as typeof fetch;
  await verifyBrainRegistered({ brainId: 'x.gm', apiKey: 'k', serverUrl: 'http://localhost:9999' });
  expect(capturedSignal).toBeInstanceOf(AbortSignal);
});

// ── createQuarantineTracker ─────────────────────────────────────────────────

test('tracker quarantines for the cooldown window and clears on success', () => {
  const tracker = createQuarantineTracker({ cooldownMs: 10_000 });
  const t0 = 1_000_000;
  expect(tracker.isQuarantined('a.gm', t0)).toBe(false);

  tracker.record('a.gm', { status: 404, code: 'not_found', message: 'nope' }, t0);
  expect(tracker.isQuarantined('a.gm', t0 + 1)).toBe(true);
  expect(tracker.isQuarantined('a.gm', t0 + 10_001)).toBe(false);

  tracker.record('a.gm', { status: 404, code: 'not_found', message: 'nope' }, t0 + 20_000);
  expect(tracker.isQuarantined('a.gm', t0 + 20_001)).toBe(true);
  expect(tracker.clear('a.gm')).toBe(true);
  expect(tracker.isQuarantined('a.gm', t0 + 20_002)).toBe(false);
  expect(tracker.clear('a.gm')).toBe(false);
});

test('tracker counts consecutive failures and exposes the entry', () => {
  const tracker = createQuarantineTracker({ cooldownMs: 5_000 });
  tracker.record('b.gm', { status: 404, code: 'not_found', message: 'x' }, 100);
  tracker.record('b.gm', { status: 404, code: 'not_found', message: 'y' }, 6_000);
  const entry = tracker.get('b.gm');
  expect(entry?.consecutiveFailures).toBe(2);
  expect(entry?.code).toBe('not_found');
  expect(typeof entry?.cooldownUntil).toBe('string');
  expect(tracker.get('nobody.gm')).toBeNull();
});

// FR A-3: repeated identical 404s inside the window must not extend the
// cooldown horizon beyond one window from the LAST failure — and a single
// propagation-race 404 can never lock a brain out permanently.
test('cooldown does not compound: horizon is one window from the last failure', () => {
  const tracker = createQuarantineTracker({ cooldownMs: 10_000 });
  tracker.record('c.gm', { status: 404, code: 'not_found', message: '' }, 0);
  tracker.record('c.gm', { status: 404, code: 'not_found', message: '' }, 1_000);
  const until = Date.parse(tracker.get('c.gm')!.cooldownUntil);
  expect(until).toBe(11_000);
});
