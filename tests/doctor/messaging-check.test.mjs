import { test, expect, describe } from 'bun:test';
import { checkMessagingRoundTrip } from '../../lib/doctor/messaging-check.js';
import { reduceHealthStatus } from '../../lib/brain/health-record.js';

describe('checkMessagingRoundTrip (FR-3)', () => {
  test('chat replies with text → pass', async () => {
    const r = await checkMessagingRoundTrip({ chat: async () => 'OK' });
    expect(r.state).toBe('pass');
    expect(r.category).toBe('messaging');
  });

  test('chat replies with an object { content } → pass', async () => {
    const r = await checkMessagingRoundTrip({ chat: async () => ({ content: 'alive' }) });
    expect(r.state).toBe('pass');
  });

  test('AC-4: chat-dead (throws) → fail (process up, chat dead)', async () => {
    const r = await checkMessagingRoundTrip({ chat: async () => { throw new Error('ECONNREFUSED'); } });
    expect(r.state).toBe('fail');
    expect(r.message).toMatch(/chat round-trip failed.*ECONNREFUSED/);
  });

  test('empty/blank reply → fail (no usable response)', async () => {
    expect((await checkMessagingRoundTrip({ chat: async () => '' })).state).toBe('fail');
    expect((await checkMessagingRoundTrip({ chat: async () => '   ' })).state).toBe('fail');
    expect((await checkMessagingRoundTrip({ chat: async () => ({ content: '' }) })).state).toBe('fail');
  });

  test('non-string / missing / null reply → fail', async () => {
    expect((await checkMessagingRoundTrip({ chat: async () => undefined })).state).toBe('fail');
    expect((await checkMessagingRoundTrip({ chat: async () => 42 })).state).toBe('fail');
    expect((await checkMessagingRoundTrip({ chat: async () => null })).state).toBe('fail');
    expect((await checkMessagingRoundTrip({ chat: async () => ({ content: 42 }) })).state).toBe('fail');
  });

  test('a hung chat times out → fail (does not block the doctor)', async () => {
    const r = await checkMessagingRoundTrip({
      chat: () => new Promise(() => {}), // never resolves
      timeoutMs: 30,
    });
    expect(r.state).toBe('fail');
    expect(r.message).toMatch(/timed out after 30ms/);
  });

  test('timeoutMs ≤0 (0 and negative) disables the timer and still passes', async () => {
    expect((await checkMessagingRoundTrip({ chat: async () => 'OK', timeoutMs: 0 })).state).toBe('pass');
    expect((await checkMessagingRoundTrip({ chat: async () => 'OK', timeoutMs: -1 })).state).toBe('pass');
  });

  test('expectReply returning a truthy non-boolean → fail (strict === true, fail-closed)', async () => {
    const r = await checkMessagingRoundTrip({ chat: async () => 'x', expectReply: () => 1 });
    expect(r.state).toBe('fail');
  });

  test('a chat that rejects AFTER the timeout → fail, with no unhandled rejection', async () => {
    let unhandled = null;
    const onUnhandled = (e) => { unhandled = e; };
    process.on('unhandledRejection', onUnhandled);
    try {
      const r = await checkMessagingRoundTrip({
        chat: () => new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 40)),
        timeoutMs: 10,
      });
      expect(r.state).toBe('fail');
      expect(r.message).toMatch(/timed out/);
      // Give the late rejection time to fire so we'd catch an unhandled one.
      await new Promise((res) => setTimeout(res, 60));
      expect(unhandled).toBeNull();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('missing chat → fail (non-skippable)', async () => {
    const r = await checkMessagingRoundTrip({});
    expect(r.state).toBe('fail');
    expect(r.message).toMatch(/no chat round-trip/);
  });

  test('passes the prompt through to chat', async () => {
    let seen = null;
    await checkMessagingRoundTrip({ chat: async (p) => { seen = p; return 'OK'; }, prompt: 'custom probe' });
    expect(seen).toBe('custom probe');
  });

  test('expectReply: a non-empty error-text/echo reply that fails the validator → fail (adversarial)', async () => {
    const r = await checkMessagingRoundTrip({
      chat: async () => 'error: model unavailable',
      expectReply: (t) => t.includes('PONG'),
    });
    expect(r.state).toBe('fail');
    expect(r.message).toMatch(/failed the expected-reply check/);
  });

  test('expectReply: a reply satisfying the validator → pass', async () => {
    const r = await checkMessagingRoundTrip({ chat: async () => 'PONG-42', expectReply: (t) => t.includes('PONG') });
    expect(r.state).toBe('pass');
  });

  test('expectReply that throws → fail (not a crash)', async () => {
    const r = await checkMessagingRoundTrip({ chat: async () => 'x', expectReply: () => { throw new Error('bad'); } });
    expect(r.state).toBe('fail');
    expect(r.message).toMatch(/validator threw/);
  });
});

describe('integration with the reducer (AC-4)', () => {
  test('process-up but chat-dead → Degraded, NOT Healthy, NOT Stuck', async () => {
    const msg = await checkMessagingRoundTrip({ chat: async () => { throw new Error('timeout'); } });
    const reduced = reduceHealthStatus({
      runtime_resolves: { state: 'pass' },        // runtime IS up
      identity_materializes: { state: 'pass' },
      credentials_authenticate: { state: 'pass' },
      messaging_round_trips: msg,                  // but chat is dead
    });
    expect(reduced.status).toBe('degraded');
    expect(reduced.reason).toMatch(/messaging_round_trips fail/);
  });

  test('chat alive + all others pass → Healthy', async () => {
    const msg = await checkMessagingRoundTrip({ chat: async () => 'OK' });
    const reduced = reduceHealthStatus({
      runtime_resolves: { state: 'pass' },
      identity_materializes: { state: 'pass' },
      credentials_authenticate: { state: 'pass' },
      messaging_round_trips: msg,
    });
    expect(reduced.status).toBe('healthy');
  });
});
