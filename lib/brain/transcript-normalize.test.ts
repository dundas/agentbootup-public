import { expect, test } from 'bun:test';
import fsp from 'fs/promises';
import path from 'path';
import { normalizeTranscriptBuffer, stringifyNormalizedEvents } from './transcript-normalize.js';

const fixtureRoot = path.resolve(import.meta.dir, '../../tests/fixtures/transcripts');

async function normalizeFixture(provider: string, filename: string) {
  const buffer = await fsp.readFile(path.join(fixtureRoot, filename)); // nosemgrep: path-join-resolve-traversal — test helper reads fixed fixture filenames.
  return normalizeTranscriptBuffer({
    provider,
    sessionId: `${provider}-session`,
    rawEntry: {
      machineId: 'machine-a',
      rawCachePath: `raw/machine-a/${provider}/${filename}`,
      sourcePath: `/native/${filename}`,
      sourceRelativePath: filename,
      contentHash: `${provider}`.padEnd(64, '0').slice(0, 64),
    },
    buffer,
  });
}

test('normalizes Claude JSONL messages to mech-run.v1 events', async () => {
  const result = await normalizeFixture('claude', 'claude.jsonl');

  expect(result.errors).toEqual([]);
  expect(result.events.map((event) => event.content)).toEqual(['hello claude', 'hi from claude']);
  expect(result.events[0]).toMatchObject({
    normalizationVersion: 'mech-run.v1',
    provider: 'claude',
    sessionId: 'claude-session',
    type: 'message',
    role: 'user',
    timestamp: '2026-05-26T01:00:00.000Z',
  });
});

test('normalizes Claude tool-use content arrays as tool events with object inputs', () => {
  const result = normalizeTranscriptBuffer({
    provider: 'claude',
    sessionId: 'claude-tools',
    rawEntry: {
      machineId: 'machine-a',
      rawCachePath: 'raw/machine-a/claude/tools.jsonl',
      sourcePath: '/native/tools.jsonl',
      sourceRelativePath: 'tools.jsonl',
      contentHash: 'claude-tools'.padEnd(64, '0').slice(0, 64),
    },
    buffer: Buffer.from(
      '{"type":"assistant","message":{"content":[{"type":"tool_use","input":{"query":"alpha"}}]}}\n',
    ),
  });

  expect(result.errors).toEqual([]);
  expect(result.events).toHaveLength(1);
  expect(result.events[0].type).toBe('tool');
  expect(result.events[0].content).toContain('"query":"alpha"');
});

test('assigns unique monotonic Claude ordinals across text and tool blocks', () => {
  const result = normalizeTranscriptBuffer({
    provider: 'claude',
    sessionId: 'claude-mixed-blocks',
    rawEntry: {
      machineId: 'machine-a',
      rawCachePath: 'raw/machine-a/claude/mixed-blocks.jsonl',
      sourcePath: '/native/mixed-blocks.jsonl',
      sourceRelativePath: 'mixed-blocks.jsonl',
      contentHash: 'claude-mixed-blocks'.padEnd(64, '0').slice(0, 64),
    },
    buffer: Buffer.from([
      '{"type":"assistant","message":{"content":[{"text":"hi"},{"type":"tool_use","input":{"query":"alpha"}}]}}',
      '{"type":"user","message":{"content":"follow-up"}}',
    ].join('\n')),
  });

  expect(result.errors).toEqual([]);
  expect(result.events.map((event) => event.provenance.ordinal)).toEqual([0, 1, 2]);
  expect(new Set(result.events.map((event) => event.eventId)).size).toBe(3);
});

test('normalizes Codex JSONL messages to mech-run.v1 events', async () => {
  const result = await normalizeFixture('codex', 'codex.jsonl');

  expect(result.errors).toEqual([]);
  expect(result.events.map((event) => event.content)).toEqual(['hello codex', 'hi from codex']);
  expect(result.events.every((event) => event.provider === 'codex')).toBe(true);
});

test('normalizes Cursor text blocks to mech-run.v1 events', async () => {
  const result = await normalizeFixture('cursor', 'cursor.txt');

  expect(result.errors).toEqual([]);
  expect(result.events.map((event) => event.role)).toEqual(['user', 'assistant']);
  expect(result.events[0].content).toContain('hello cursor');
});

test('normalizes Gemini JSON messages to mech-run.v1 events', async () => {
  const result = await normalizeFixture('gemini', 'gemini.json');

  expect(result.errors).toEqual([]);
  expect(result.events.map((event) => event.content)).toEqual(['hello gemini', 'hi from gemini']);
  expect(result.events[1].role).toBe('assistant');
});

test('normalizes Gemini tool calls with stable sequential ordinals', () => {
  const result = normalizeTranscriptBuffer({
    provider: 'gemini',
    sessionId: 'gemini-session',
    rawEntry: {
      machineId: 'machine-a',
      rawCachePath: 'raw/machine-a/gemini/toolcalls.json',
      sourcePath: '/native/toolcalls.json',
      sourceRelativePath: 'toolcalls.json',
      contentHash: 'gemini-tools'.padEnd(64, '0').slice(0, 64),
    },
    buffer: Buffer.from(JSON.stringify({
      messages: [{
        role: 'assistant',
        text: 'hi',
        toolCalls: [
          { name: 'search', arguments: { q: 'alpha' } },
          { name: 'search', arguments: { q: 'beta' } },
        ],
      }],
    })),
  });

  expect(result.errors).toEqual([]);
  expect(result.events.map((event) => event.provenance.ordinal)).toEqual([0, 1, 2]);
  expect(result.events[1].eventId).not.toBe(result.events[2].eventId);
});

test('preserves numeric Gemini message timestamps when session start time exists', () => {
  const result = normalizeTranscriptBuffer({
    provider: 'gemini',
    sessionId: 'gemini-session',
    rawEntry: {
      machineId: 'machine-a',
      rawCachePath: 'raw/machine-a/gemini/epoch.json',
      sourcePath: '/native/epoch.json',
      sourceRelativePath: 'epoch.json',
      contentHash: 'gemini-epoch'.padEnd(64, '0').slice(0, 64),
    },
    buffer: Buffer.from(JSON.stringify({
      startTime: '2026-05-26T00:00:00.000Z',
      messages: [{
        role: 'assistant',
        timestamp: 0,
        text: 'epoch',
      }],
    })),
  });

  expect(result.errors).toEqual([]);
  expect(result.events[0].timestamp).toBe('1970-01-01T00:00:00.000Z');
});

test('passes through existing mech-run.v1 JSONL with refreshed provenance', async () => {
  const result = await normalizeFixture('claude', 'mech-run.jsonl');

  expect(result.errors).toEqual([]);
  expect(result.events).toHaveLength(1);
  expect(result.events[0].eventId).not.toBe('evt-1');
  expect(result.events[0].provenance.rawCachePath).toBe('raw/machine-a/claude/mech-run.jsonl');
});

test('keeps valid mech-run events and reports mixed-format mismatches', () => {
  const result = normalizeTranscriptBuffer({
    provider: 'claude',
    sessionId: 'mixed-session',
    rawEntry: {
      machineId: 'machine-a',
      rawCachePath: 'raw/machine-a/claude/mixed.jsonl',
      sourcePath: '/native/mixed.jsonl',
      sourceRelativePath: 'mixed.jsonl',
      contentHash: 'mixed'.padEnd(64, '0').slice(0, 64),
    },
    buffer: Buffer.from([
      '{"schemaVersion":1,"normalizationVersion":"mech-run.v1","eventId":"evt-1","sessionId":"evt-session","provider":"claude","timestamp":"2026-05-26T00:00:00.000Z","type":"message","role":"user","content":"hello","provenance":{"ordinal":0}}',
      '{"meta":"sidecar"}',
    ].join('\n')),
  });

  expect(result.events).toHaveLength(1);
  expect(result.events[0].content).toBe('hello');
  expect(result.errors).toEqual([{ type: 'normalization_failed', index: 1, error: 'mech_run_record_mismatch' }]);
});

test('detects mech-run passthrough when sidecar metadata precedes the first event', () => {
  const result = normalizeTranscriptBuffer({
    provider: 'claude',
    sessionId: 'sidecar-first',
    rawEntry: {
      machineId: 'machine-a',
      rawCachePath: 'raw/machine-a/claude/sidecar-first.jsonl',
      sourcePath: '/native/sidecar-first.jsonl',
      sourceRelativePath: 'sidecar-first.jsonl',
      contentHash: 'sidecar-first'.padEnd(64, '0').slice(0, 64),
    },
    buffer: Buffer.from([
      '{"meta":"sidecar"}',
      '{"schemaVersion":1,"normalizationVersion":"mech-run.v1","eventId":"evt-1","sessionId":"evt-session","provider":"claude","timestamp":"2026-05-26T00:00:00.000Z","type":"message","role":"user","content":"hello","provenance":{"ordinal":0}}',
    ].join('\n')),
  });

  expect(result.events).toHaveLength(1);
  expect(result.events[0].content).toBe('hello');
  expect(result.errors).toEqual([{ type: 'normalization_failed', index: 0, error: 'mech_run_record_mismatch' }]);
});

test('ignores bare Claude role markers when deciding mech-run passthrough', () => {
  const result = normalizeTranscriptBuffer({
    provider: 'claude',
    sessionId: 'bare-role-first',
    rawEntry: {
      machineId: 'machine-a',
      rawCachePath: 'raw/machine-a/claude/bare-role-first.jsonl',
      sourcePath: '/native/bare-role-first.jsonl',
      sourceRelativePath: 'bare-role-first.jsonl',
      contentHash: 'bare-role-first'.padEnd(64, '0').slice(0, 64),
    },
    buffer: Buffer.from([
      '{"type":"user"}',
      '{"schemaVersion":1,"normalizationVersion":"mech-run.v1","eventId":"evt-1","sessionId":"evt-session","provider":"claude","timestamp":"2026-05-26T00:00:00.000Z","type":"message","role":"user","content":"hello","provenance":{"ordinal":0}}',
    ].join('\n')),
  });

  expect(result.events).toHaveLength(1);
  expect(result.events[0].content).toBe('hello');
  expect(result.errors).toEqual([{ type: 'normalization_failed', index: 0, error: 'mech_run_record_mismatch' }]);
});

test('ignores empty Codex response-item messages when deciding mech-run passthrough', () => {
  const result = normalizeTranscriptBuffer({
    provider: 'codex',
    sessionId: 'codex-sidecar-first',
    rawEntry: {
      machineId: 'machine-a',
      rawCachePath: 'raw/machine-a/codex/codex-sidecar-first.jsonl',
      sourcePath: '/native/codex-sidecar-first.jsonl',
      sourceRelativePath: 'codex-sidecar-first.jsonl',
      contentHash: 'codex-sidecar-first'.padEnd(64, '0').slice(0, 64),
    },
    buffer: Buffer.from([
      '{"type":"response_item","payload":{"type":"message","content":[]}}',
      '{"schemaVersion":1,"normalizationVersion":"mech-run.v1","eventId":"evt-1","sessionId":"evt-session","provider":"codex","timestamp":"2026-05-26T00:00:00.000Z","type":"message","role":"assistant","content":"hello","provenance":{"ordinal":0}}',
    ].join('\n')),
  });

  expect(result.events).toHaveLength(1);
  expect(result.events[0].content).toBe('hello');
  expect(result.errors).toEqual([{ type: 'normalization_failed', index: 0, error: 'mech_run_record_mismatch' }]);
});

test('does not hijack provider normalization when a mech-run record appears after native records', () => {
  const result = normalizeTranscriptBuffer({
    provider: 'claude',
    sessionId: 'native-first',
    rawEntry: {
      machineId: 'machine-a',
      rawCachePath: 'raw/machine-a/claude/native-first.jsonl',
      sourcePath: '/native/native-first.jsonl',
      sourceRelativePath: 'native-first.jsonl',
      contentHash: 'native-first'.padEnd(64, '0').slice(0, 64),
    },
    buffer: Buffer.from([
      '{"type":"user","message":{"content":"hello native"},"timestamp":"2026-05-26T00:00:00.000Z"}',
      '{"schemaVersion":1,"normalizationVersion":"mech-run.v1","eventId":"evt-1","sessionId":"evt-session","provider":"claude","timestamp":"2026-05-26T00:00:01.000Z","type":"message","role":"assistant","content":"sidecar","provenance":{"ordinal":1}}',
    ].join('\n')),
  });

  expect(result.errors).toEqual([]);
  expect(result.events).toHaveLength(2);
  expect(result.events[0].content).toBe('hello native');
  expect(result.events[1].content).toContain('sidecar');
});

test('does not treat sidecar plus native Claude tool-only rows as mech-run passthrough', () => {
  const result = normalizeTranscriptBuffer({
    provider: 'claude',
    sessionId: 'native-tool-first',
    rawEntry: {
      machineId: 'machine-a',
      rawCachePath: 'raw/machine-a/claude/native-tool-first.jsonl',
      sourcePath: '/native/native-tool-first.jsonl',
      sourceRelativePath: 'native-tool-first.jsonl',
      contentHash: 'native-tool-first'.padEnd(64, '0').slice(0, 64),
    },
    buffer: Buffer.from([
      '{"meta":"sidecar"}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","input":{"query":"alpha"}}]}}',
      '{"schemaVersion":1,"normalizationVersion":"mech-run.v1","eventId":"evt-1","sessionId":"evt-session","provider":"claude","timestamp":"2026-05-26T00:00:01.000Z","type":"message","role":"assistant","content":"sidecar","provenance":{"ordinal":1}}',
    ].join('\n')),
  });

  expect(result.errors).toEqual([]);
  expect(result.events).toHaveLength(2);
  expect(result.events[0].type).toBe('tool');
  expect(result.events[0].content).toContain('"query":"alpha"');
  expect(result.events[1].content).toContain('sidecar');
});

test('reports malformed transcript input without throwing', () => {
  const result = normalizeTranscriptBuffer({
    provider: 'claude',
    sessionId: 'bad-session',
    rawEntry: {
      machineId: 'machine-a',
      rawCachePath: 'raw/machine-a/claude/bad.jsonl',
      sourcePath: '/native/bad.jsonl',
      sourceRelativePath: 'bad.jsonl',
      contentHash: 'bad'.padEnd(64, '0'),
    },
    buffer: Buffer.from('{not json}\n'),
  });

  expect(result.events).toEqual([]);
  expect(result.errors[0].type).toBe('normalization_failed');
});

test('reports unknown providers explicitly instead of falling back to Claude normalization', () => {
  const result = normalizeTranscriptBuffer({
    provider: 'future-provider',
    sessionId: 'unknown-provider',
    rawEntry: {
      machineId: 'machine-a',
      rawCachePath: 'raw/machine-a/future-provider/session.jsonl',
      sourcePath: '/native/session.jsonl',
      sourceRelativePath: 'session.jsonl',
      contentHash: 'future-provider'.padEnd(64, '0').slice(0, 64),
    },
    buffer: Buffer.from('{"type":"user","message":{"content":"hello"}}\n'),
  });

  expect(result.events).toEqual([]);
  expect(result.errors).toEqual([{ type: 'normalization_failed', error: 'unknown_provider:future-provider' }]);
});

test('stringifyNormalizedEvents is deterministic', async () => {
  const first = await normalizeFixture('claude', 'claude.jsonl');
  const second = await normalizeFixture('claude', 'claude.jsonl');

  expect(stringifyNormalizedEvents(first.events)).toBe(stringifyNormalizedEvents(second.events));
});
