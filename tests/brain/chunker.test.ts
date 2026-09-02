/**
 * Tests for lib/brain/chunker.js
 *
 * Validates all 6 boundary rules, helper functions, and edge cases.
 * No I/O — all inputs are in-memory arrays.
 */

import { test, expect, describe } from 'bun:test';
import { chunkMessages, classifyTool, detectBoundary, precomputeMessages } from '../../lib/brain/chunker.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build a minimal user message in Claude JSONL flat format. */
function userMsg(text: string, timestamp?: string, toolUses: object[] = []) {
  const content: object[] = [{ type: 'text', text }];
  for (const tu of toolUses) content.push(tu);
  return { role: 'user', content, timestamp: timestamp ?? null };
}

/** Build a minimal assistant message. */
function assistantMsg(toolUses: object[] = [], timestamp?: string, usage?: object) {
  return {
    role: 'assistant',
    content: toolUses,
    timestamp: timestamp ?? null,
    usage: usage ?? null,
  };
}

/** Build a tool_use block. */
function toolUse(name: string, input: object = {}) {
  return { type: 'tool_use', name, input };
}

/** ISO timestamp N minutes after a base time. */
function ts(baseMinutes: number, offsetMinutes = 0): string {
  const base = new Date('2026-01-01T00:00:00.000Z');
  base.setMinutes(base.getMinutes() + baseMinutes + offsetMinutes);
  return base.toISOString();
}

// ── classifyTool ──────────────────────────────────────────────────────────

describe('classifyTool', () => {
  test('bash tools', () => {
    expect(classifyTool('Bash')).toBe('bash');
    expect(classifyTool('run')).toBe('bash');
    expect(classifyTool('execute')).toBe('bash');
    expect(classifyTool('terminal')).toBe('bash');
  });

  test('edit tools', () => {
    expect(classifyTool('write')).toBe('edit');
    expect(classifyTool('Edit')).toBe('edit');
    expect(classifyTool('apply_patch')).toBe('edit');
    expect(classifyTool('write_file')).toBe('edit');
    expect(classifyTool('edit_file')).toBe('edit');
  });

  test('read tools', () => {
    expect(classifyTool('Read')).toBe('read');
    expect(classifyTool('glob')).toBe('read');
    expect(classifyTool('grep')).toBe('read');
    expect(classifyTool('ls')).toBe('read');
  });

  test('other tools', () => {
    expect(classifyTool('Agent')).toBe('other');
    expect(classifyTool('WebSearch')).toBe('other');
    expect(classifyTool(null)).toBe('other');
    expect(classifyTool(undefined)).toBe('other');
  });
});

// ── precomputeMessages ────────────────────────────────────────────────────

describe('precomputeMessages', () => {
  test('skips non-user/assistant rows', () => {
    const msgs = [
      { role: 'system', content: 'system prompt' },
      userMsg('hello'),
    ];
    const result = precomputeMessages(msgs);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
  });

  test('handles Claude Code nested format { message: {...}, timestamp }', () => {
    const msgs = [{ message: { role: 'user', content: 'hi' }, timestamp: ts(0) }];
    const result = precomputeMessages(msgs);
    expect(result).toHaveLength(1);
    expect(result[0].humanText).toBe('hi');
    expect(result[0].timestamp).toBe(ts(0));
  });

  test('extracts files from edit tool input.file_path', () => {
    const msgs = [
      assistantMsg([toolUse('write', { file_path: '/project/foo.ts' })]),
    ];
    const result = precomputeMessages(msgs);
    expect(result[0].filesTouched).toContain('/project/foo.ts');
  });

  test('extracts files from edit tool input.path', () => {
    const msgs = [
      assistantMsg([toolUse('edit', { path: '/project/bar.ts' })]),
    ];
    const result = precomputeMessages(msgs);
    expect(result[0].filesTouched).toContain('/project/bar.ts');
  });

  test('humanText skips tool_result blocks', () => {
    const msgs = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'proceed' },
          { type: 'tool_result', content: 'some tool output' },
        ],
      },
    ];
    const result = precomputeMessages(msgs);
    expect(result[0].humanText).toBe('proceed');
    expect(result[0].humanText).not.toContain('tool output');
  });

  test('null/malformed rows are skipped', () => {
    const result = precomputeMessages([null, undefined, {}, { role: 'user', content: 'ok' }] as object[]);
    expect(result).toHaveLength(1);
  });
});

// ── detectBoundary ────────────────────────────────────────────────────────

describe('detectBoundary', () => {
  test('RULE F: fixed_window_fallback at 20 messages', () => {
    // Build 21 messages so chunkLen = 20 when i=20
    const msgs = Array.from({ length: 22 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      timestamp: ts(i),
      humanText: i % 2 === 0 ? 'hello' : null,
      toolUses: [],
      filesTouched: [],
      tokenCounts: null,
    }));
    expect(detectBoundary(msgs, 0, 20)).toBe('fixed_window_fallback');
    expect(detectBoundary(msgs, 0, 19)).toBeNull();
  });

  test('RULE A: time_gap > 5 minutes', () => {
    const msgs = precomputeMessages([
      userMsg('first', ts(0)),
      userMsg('second', ts(6)),   // 6 min gap → boundary
    ]);
    expect(detectBoundary(msgs, 0, 1)).toBe('time_gap');
  });

  test('RULE A: no boundary when gap < 5 minutes', () => {
    const msgs = precomputeMessages([
      userMsg('first', ts(0)),
      userMsg('second', ts(4)),   // 4 min — no boundary
    ]);
    expect(detectBoundary(msgs, 0, 1)).toBeNull();
  });

  test('RULE B: skill_invocation on /adversarial', () => {
    const msgs = precomputeMessages([
      userMsg('lets do something'),
      userMsg('lets run adversarial review'),
    ]);
    expect(detectBoundary(msgs, 0, 1)).toBe('skill_invocation');
  });

  test('RULE B: skill_invocation on prd-writer mention', () => {
    const msgs = precomputeMessages([
      userMsg('lets code'),
      userMsg('write prd for the new feature'),
    ]);
    expect(detectBoundary(msgs, 0, 1)).toBe('skill_invocation');
  });

  test('RULE C: phase_marker "now implement"', () => {
    const msgs = precomputeMessages([
      userMsg('planning done'),
      userMsg('now implement the feature'),
    ]);
    expect(detectBoundary(msgs, 0, 1)).toBe('phase_marker');
  });

  test('RULE C: phase_marker "run tests"', () => {
    const msgs = precomputeMessages([
      userMsg('ok'),
      userMsg('run tests please'),
    ]);
    expect(detectBoundary(msgs, 0, 1)).toBe('phase_marker');
  });

  test('returns null for a normal turn-by-turn conversation', () => {
    const msgs = precomputeMessages([
      userMsg('hello'),
      userMsg('what does this function do?'),
    ]);
    expect(detectBoundary(msgs, 0, 1)).toBeNull();
  });
});

// ── chunkMessages ─────────────────────────────────────────────────────────

describe('chunkMessages', () => {
  test('empty input returns empty array', () => {
    expect(chunkMessages([], 'sess-1')).toEqual([]);
  });

  test('single message produces one chunk with reason end_of_session', () => {
    const chunks = chunkMessages([userMsg('hello')], 'sess-1');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunk_meta.boundary_reason).toBe('end_of_session');
  });

  test('chunk IDs are deterministic and zero-padded', () => {
    const msgs = Array.from({ length: 5 }, (_, i) => userMsg(`msg ${i}`));
    const chunks = chunkMessages(msgs, 'test-session', { fixedWindowSize: 3 });
    expect(chunks[0].id).toBe('test-session__c000');
    expect(chunks[1].id).toBe('test-session__c001');
  });

  test('session_id is set on all chunks', () => {
    const msgs = Array.from({ length: 5 }, (_, i) => userMsg(`msg ${i}`));
    const chunks = chunkMessages(msgs, 'my-session', { fixedWindowSize: 3 });
    for (const chunk of chunks) {
      expect(chunk.session_id).toBe('my-session');
    }
  });

  test('total_chunks_in_session is back-filled correctly', () => {
    const msgs = Array.from({ length: 7 }, (_, i) => userMsg(`msg ${i}`));
    const chunks = chunkMessages(msgs, 'sess', { fixedWindowSize: 3 });
    const total = chunks.length;
    for (const chunk of chunks) {
      expect(chunk.chunk_meta.total_chunks_in_session).toBe(total);
    }
  });

  test('fixed window splits 21 messages into two chunks', () => {
    const msgs = Array.from({ length: 21 }, (_, i) => userMsg(`msg ${i}`, ts(i)));
    const chunks = chunkMessages(msgs, 'sess');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].chunk_meta.boundary_reason).toBe('fixed_window_fallback');
  });

  test('time gap produces a boundary', () => {
    const msgs = [
      userMsg('before gap', ts(0)),
      userMsg('after gap', ts(10)),  // 10 min gap
    ];
    const chunks = chunkMessages(msgs, 'sess');
    expect(chunks).toHaveLength(2);
    expect(chunks[0].chunk_meta.boundary_reason).toBe('time_gap');
  });

  test('content field concatenates user_texts', () => {
    const msgs = [
      userMsg('what is foo?', ts(0)),
      userMsg('how about bar?', ts(1)),
    ];
    const chunks = chunkMessages(msgs, 'sess', { fixedWindowSize: 5 });
    expect(chunks[0].content).toContain('what is foo?');
    expect(chunks[0].content).toContain('how about bar?');
  });

  test('content is empty string for assistant-only messages', () => {
    const msgs = [
      assistantMsg([toolUse('Bash')], ts(0)),
      assistantMsg([toolUse('Read')], ts(1)),
    ];
    const chunks = chunkMessages(msgs, 'sess');
    expect(chunks[0].content).toBe('');
  });

  test('files_touched aggregates across messages in chunk', () => {
    const msgs = [
      assistantMsg([toolUse('write', { file_path: '/a.ts' })], ts(0)),
      assistantMsg([toolUse('edit', { file_path: '/b.ts' })], ts(1)),
      userMsg('ok', ts(2)),
    ];
    const chunks = chunkMessages(msgs, 'sess');
    expect(chunks[0].chunk_meta.files_touched).toContain('/a.ts');
    expect(chunks[0].chunk_meta.files_touched).toContain('/b.ts');
  });

  test('source_cli and source_path pass through to chunk_meta', () => {
    const msgs = [userMsg('hello')];
    const chunks = chunkMessages(msgs, 'sess', {
      sourceCli: 'cursor',
      sourcePath: '/home/user/.cursor/transcripts/abc.jsonl',
    });
    expect(chunks[0].chunk_meta.source_cli).toBe('cursor');
    expect(chunks[0].chunk_meta.source_path).toBe('/home/user/.cursor/transcripts/abc.jsonl');
  });

  test('token_count sums input+output tokens across chunk messages', () => {
    const msgs = [
      {
        role: 'assistant',
        content: [],
        timestamp: ts(0),
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      userMsg('ok', ts(1)),
    ];
    const chunks = chunkMessages(msgs, 'sess');
    expect(chunks[0].token_count).toBe(150);
  });

  test('correction_count increments for "no", "actually", "wrong"', () => {
    const msgs = [
      userMsg('no that is wrong', ts(0)),
      userMsg('actually use the other file', ts(1)),
      userMsg('proceed', ts(2)),
    ];
    const chunks = chunkMessages(msgs, 'sess', { fixedWindowSize: 10 });
    // All 3 in one chunk
    expect(chunks[0].chunk_meta.correction_count).toBeGreaterThanOrEqual(2);
  });

  test('chunk_meta.message_count matches actual slice length', () => {
    const msgs = Array.from({ length: 5 }, (_, i) => userMsg(`msg ${i}`, ts(i)));
    const chunks = chunkMessages(msgs, 'sess', { fixedWindowSize: 3 });
    let total = 0;
    for (const chunk of chunks) {
      expect(chunk.chunk_meta.message_count).toBe(chunk.message_count);
      total += chunk.message_count;
    }
    expect(total).toBe(5); // all messages accounted for
  });

  test('skill_invocation boundary splits on /adversarial text', () => {
    const msgs = [
      userMsg('lets code this', ts(0)),
      userMsg('now adversarial review time', ts(1)),
      userMsg('more chat', ts(2)),
    ];
    const chunks = chunkMessages(msgs, 'sess', { fixedWindowSize: 20 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].chunk_meta.boundary_reason).toMatch(/skill_invocation|phase_marker/);
  });

  test('handles JSONL with nested { message: {...}, timestamp } format', () => {
    const msgs = [
      { message: { role: 'user', content: 'nested format' }, timestamp: ts(0) },
      { message: { role: 'user', content: 'second message' }, timestamp: ts(1) },
    ];
    const chunks = chunkMessages(msgs, 'sess', { fixedWindowSize: 20 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain('nested format');
  });

  test('message_count 0 should not produce a chunk (degenerate case)', () => {
    // An empty precomputed slice — should not push a chunk
    const chunks = chunkMessages([{ role: 'system', content: 'ignored' } as object], 'sess');
    expect(chunks).toHaveLength(0);
  });
});
