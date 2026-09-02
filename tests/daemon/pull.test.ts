/**
 * Tests for lib/sync/pull.js — sync-daemon pull handler.
 *
 * Uses a mock fetch to avoid real HTTP calls.
 * All tests that exercise early-exit paths stub process.exit to prevent
 * the bun test runner from being killed.
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import os from 'os';
import path from 'path';
import fsp from 'fs/promises';
import crypto from 'crypto';

// ── Test isolation ────────────────────────────────────────────────────────────

let tmpDir: string;

function tmpId() { return crypto.randomBytes(8).toString('hex'); }

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `agentbootup-pull-test-${tmpId()}`);
  await fsp.mkdir(tmpDir, { recursive: true });
  process.env.AGENTBOOTUP_CONFIG_FILE = path.join(tmpDir, 'config.json');
  process.env.AGENTBOOTUP_CREDS_FILE = path.join(tmpDir, 'credentials');
});

afterEach(async () => {
  delete process.env.AGENTBOOTUP_CONFIG_FILE;
  delete process.env.AGENTBOOTUP_CREDS_FILE;
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const { writeCredentials } = await import('../../lib/auth/credentials.js');
const { setBrainId, writeConfig } = await import('../../lib/config/config.js');
const { handleDaemonPull } = await import('../../lib/sync/pull.js');

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) },
    out, err,
  };
}

async function writeCreds() {
  await writeCredentials({ apiKey: 'test-key-1234', serverUrl: 'http://localhost:0' });
}

/** Stub process.exit so tests that trigger early exit don't kill the runner. */
function stubExit(): { exited: boolean; restore: () => void } {
  const state = { exited: false };
  const origExit = process.exit;
  // @ts-ignore
  process.exit = () => { state.exited = true; throw new Error('exit'); };
  return { exited: false, restore: () => { // @ts-ignore
    process.exit = origExit; },
    get exited() { return state.exited; },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('handleDaemonPull exits when no brain ID configured', async () => {
  await writeCreds();
  await writeConfig({});  // ensure brain ID is absent
  const { io, out, err } = captureIo();
  const exit = stubExit();
  try {
    await handleDaemonPull([], io, { cwd: tmpDir }).catch(() => {});
  } finally {
    exit.restore();
  }
  expect(exit.exited || err.length > 0).toBe(true);
});

test('handleDaemonPull rejects invalid --cli value', async () => {
  await writeCreds();
  await setBrainId('brain-abc');
  const { io, out, err } = captureIo();
  const exit = stubExit();
  try {
    await handleDaemonPull(['--cli', 'invalid-tool'], io).catch(() => {});
  } finally {
    exit.restore();
  }
  expect(exit.exited || err.some((l) => l.includes('Invalid --cli'))).toBe(true);
});

test('handleDaemonPull rejects invalid --since value', async () => {
  await writeCreds();
  await setBrainId('brain-abc');
  const { io, err } = captureIo();
  const exit = stubExit();
  try {
    await handleDaemonPull(['--since', 'not-a-date'], io).catch(() => {});
  } finally {
    exit.restore();
  }
  expect(exit.exited || err.some((l) => l.includes('Invalid --since'))).toBe(true);
});

test('handleDaemonPull rejects non-ISO --since like "Jan 1 2026"', async () => {
  await writeCreds();
  await setBrainId('brain-abc');
  const { io, err } = captureIo();
  const exit = stubExit();
  try {
    await handleDaemonPull(['--since', 'Jan 1 2026'], io).catch(() => {});
  } finally {
    exit.restore();
  }
  expect(exit.exited || err.some((l) => l.includes('Invalid --since'))).toBe(true);
});

test('handleDaemonPull skips files with path-traversal machine_id', async () => {
  await writeCreds();
  await setBrainId('brain-abc');

  const maliciousTranscripts = [
    { key: 'transcripts/brain-abc/x/claude/chat.jsonl', cli: 'claude', filename: 'chat.jsonl', relative_path: 'chat.jsonl', machine_id: '../../evil', size: 5 },
  ];

  const origFetch = globalThis.fetch;
  // @ts-ignore
  globalThis.fetch = async (url: string) => {
    if (url.includes('/v1/sync/transcripts/pull')) {
      return { ok: true, json: async () => ({ data: { transcripts: maliciousTranscripts } }) };
    }
    throw new Error('download should not be called');
  };

  const outputDir = path.join(tmpDir, 'out-traversal');
  const { io, err } = captureIo();
  const exit = stubExit();
  try {
    await handleDaemonPull(['--output-dir', outputDir], io).catch(() => {});
  } finally {
    globalThis.fetch = origFetch;
    exit.restore();
  }

  expect(err.some((l) => l.includes('Path traversal') || l.includes('Skipping'))).toBe(true);
});

test('handleDaemonPull --dry-run lists files without writing', async () => {
  await writeCreds();
  await setBrainId('brain-abc');

  const mockTranscripts = [
    { key: 'transcripts/brain-abc/m1/claude/chat.jsonl', cli: 'claude', filename: 'chat.jsonl', relative_path: 'chat.jsonl', machine_id: 'm1', size: 1024 },
    { key: 'transcripts/brain-abc/m1/gemini/session.jsonl', cli: 'gemini', filename: 'session.jsonl', relative_path: 'session.jsonl', machine_id: 'm1', size: 512 },
  ];

  const origFetch = globalThis.fetch;
  // @ts-ignore
  globalThis.fetch = async (url: string) => {
    if (url.includes('/v1/sync/transcripts/pull')) {
      return { ok: true, json: async () => ({ data: { transcripts: mockTranscripts } }) };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const outputDir = path.join(tmpDir, 'out');
  const { io, out } = captureIo();
  try {
    await handleDaemonPull(['--output-dir', outputDir, '--dry-run'], io);
  } finally {
    globalThis.fetch = origFetch;
  }

  const exists = await fsp.access(outputDir).then(() => true).catch(() => false);
  expect(exists).toBe(false);
  expect(out.some((l) => l.includes('Found 2'))).toBe(true);
  expect(out.some((l) => l.includes('Dry run'))).toBe(true);
  expect(out.some((l) => l.includes('claude/chat.jsonl'))).toBe(true);
  expect(out.some((l) => l.includes('gemini/session.jsonl'))).toBe(true);
});

test('handleDaemonPull downloads and writes files', async () => {
  await writeCreds();
  await setBrainId('brain-abc');

  const mockTranscripts = [
    { key: 'transcripts/brain-abc/m1/claude/chat.jsonl', cli: 'claude', filename: 'chat.jsonl', relative_path: 'chat.jsonl', machine_id: 'm1', size: 5 },
  ];
  const mockContent = Buffer.from('hello');

  const origFetch = globalThis.fetch;
  // @ts-ignore
  globalThis.fetch = async (url: string) => {
    if (url.includes('/v1/sync/transcripts/pull')) {
      return { ok: true, json: async () => ({ data: { transcripts: mockTranscripts } }) };
    }
    if (url.includes('/v1/sync/transcripts/download')) {
      return { ok: true, arrayBuffer: async () => mockContent.buffer };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const outputDir = path.join(tmpDir, 'out');
  const { io, out } = captureIo();
  try {
    await handleDaemonPull(['--output-dir', outputDir], io);
  } finally {
    globalThis.fetch = origFetch;
  }

  const written = await fsp.readFile(path.join(outputDir, 'm1', 'claude', 'chat.jsonl'));
  expect(written.toString()).toBe('hello');
  expect(out.some((l) => l.includes('1 downloaded'))).toBe(true);
});

test('handleDaemonPull reports empty result gracefully', async () => {
  await writeCreds();
  await setBrainId('brain-abc');

  const origFetch = globalThis.fetch;
  // @ts-ignore
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: { transcripts: [], total: 0 } }) });
  const { io, out } = captureIo();
  try {
    await handleDaemonPull([], io);
  } finally {
    globalThis.fetch = origFetch;
  }
  expect(out.some((l) => l.includes('No transcripts found'))).toBe(true);
});

// ── safeDest unit tests ───────────────────────────────────────────────────────

// Import safeDest for direct testing via a re-export shim — it's not exported
// from pull.js, so we verify the invariant through the handleDaemonPull API.
// The path-traversal test above already covers the machine_id case.
// These tests cover the safeDest function behavior indirectly.

test('handleDaemonPull rejects path-traversal via filename "../evil.jsonl"', async () => {
  await writeCreds();
  await setBrainId('brain-abc');
  const origFetch = globalThis.fetch;
  // @ts-ignore
  globalThis.fetch = async (url: string) => {
    if (url.includes('/v1/sync/transcripts/pull')) {
      return { ok: true, json: async () => ({ data: { transcripts: [
        { key: 'k', cli: 'claude', filename: '../evil.jsonl', relative_path: '../evil.jsonl', machine_id: 'm1', size: 5 },
      ] } }) };
    }
    throw new Error('download should not be called');
  };
  const outputDir = path.join(tmpDir, 'out-fn-traversal');
  const { io } = captureIo();
  let code = 0;
  try {
    code = await handleDaemonPull(['--output-dir', outputDir], io);
  } finally {
    globalThis.fetch = origFetch;
  }
  expect(code).toBe(1);
  const escaped = await fsp.access(path.join(path.dirname(outputDir), 'evil.jsonl')).then(() => true).catch(() => false);
  expect(escaped).toBe(false);
});

test('handleDaemonPull preserves relative_path subdirectory structure', async () => {
  await writeCreds();
  await setBrainId('brain-abc');
  const content = Buffer.from('{"project":"session"}');
  const origFetch = globalThis.fetch;
  // @ts-ignore
  globalThis.fetch = async (url: string) => {
    if (url.includes('/v1/sync/transcripts/pull')) {
      return { ok: true, json: async () => ({ data: { transcripts: [
        { key: 'k', cli: 'claude', filename: 'session.jsonl',
          relative_path: '-Users-alice-myproject/session.jsonl', machine_id: 'machine-a', size: content.length },
      ] } }) };
    }
    if (url.includes('/v1/sync/transcripts/download')) {
      return { ok: true, arrayBuffer: async () => content.buffer };
    }
    throw new Error(`Unexpected: ${url}`);
  };
  const outputDir = path.join(tmpDir, 'out-subdir');
  const { io, out } = captureIo();
  try {
    await handleDaemonPull(['--output-dir', outputDir], io);
  } finally {
    globalThis.fetch = origFetch;
  }
  // File should land at <outputDir>/machine-a/claude/-Users-alice-myproject/session.jsonl
  const dest = path.join(outputDir, 'machine-a', 'claude', '-Users-alice-myproject', 'session.jsonl');
  const written = await fsp.readFile(dest);
  expect(written.toString()).toBe('{"project":"session"}');
  expect(out.some((l) => l.includes('1 downloaded'))).toBe(true);
});

test('handleDaemonPull accepts valid safe paths', async () => {
  await writeCreds();
  await setBrainId('brain-abc');
  const content = Buffer.from('{"ok":true}');
  const origFetch = globalThis.fetch;
  // @ts-ignore
  globalThis.fetch = async (url: string) => {
    if (url.includes('/v1/sync/transcripts/pull')) {
      return { ok: true, json: async () => ({ data: { transcripts: [
        { key: 'k', cli: 'claude', filename: 'safe-file.jsonl', relative_path: 'safe-file.jsonl', machine_id: 'machine-a', size: content.length },
      ] } }) };
    }
    if (url.includes('/v1/sync/transcripts/download')) {
      return { ok: true, arrayBuffer: async () => content.buffer };
    }
    throw new Error(`Unexpected: ${url}`);
  };
  const outputDir = path.join(tmpDir, 'out-safe');
  const { io, out } = captureIo();
  try {
    await handleDaemonPull(['--output-dir', outputDir], io);
  } finally {
    globalThis.fetch = origFetch;
  }
  const dest = path.join(outputDir, 'machine-a', 'claude', 'safe-file.jsonl');
  const written = await fsp.readFile(dest);
  expect(written.toString()).toBe('{"ok":true}');
  expect(out.some((l) => l.includes('1 downloaded'))).toBe(true);
});

test('handleDaemonPull verifies content_sha256 and warns on mismatch', async () => {
  await writeCreds();
  await setBrainId('brain-abc');
  const content = Buffer.from('transcript data');
  const origFetch = globalThis.fetch;
  // @ts-ignore
  globalThis.fetch = async (url: string) => {
    if (url.includes('/v1/sync/transcripts/pull')) {
      return { ok: true, json: async () => ({ data: { transcripts: [
        { key: 'k', cli: 'claude', filename: 'f.jsonl', relative_path: 'f.jsonl',
          machine_id: 'm1', size: content.length, content_sha256: 'badhash' },
      ] } }) };
    }
    if (url.includes('/v1/sync/transcripts/download')) {
      return { ok: true, arrayBuffer: async () => content.buffer };
    }
    throw new Error(`Unexpected: ${url}`);
  };
  const outputDir = path.join(tmpDir, 'out-integrity');
  const { io, err } = captureIo();
  try {
    await handleDaemonPull(['--output-dir', outputDir], io);
  } finally {
    globalThis.fetch = origFetch;
  }
  expect(err.some((l) => l.includes('Integrity mismatch') || l.includes('mismatch'))).toBe(true);
});

test('handleDaemonPull passes silently when content_sha256 matches', async () => {
  await writeCreds();
  await setBrainId('brain-abc');
  const content = Buffer.from('{"ok":true}');
  const { createHash } = await import('crypto');
  const goodHash = createHash('sha256').update(content).digest('hex');

  const origFetch = globalThis.fetch;
  // @ts-ignore
  globalThis.fetch = async (url: string) => {
    if (url.includes('/v1/sync/transcripts/pull')) {
      return { ok: true, json: async () => ({ data: { transcripts: [
        { key: 'k', cli: 'claude', filename: 'ok.jsonl', relative_path: 'ok.jsonl',
          machine_id: 'm1', size: content.length, content_sha256: goodHash },
      ] } }) };
    }
    if (url.includes('/v1/sync/transcripts/download')) {
      return { ok: true, arrayBuffer: async () => content.buffer };
    }
    throw new Error(`Unexpected: ${url}`);
  };
  const outputDir = path.join(tmpDir, 'out-integrity-ok');
  const { io, err } = captureIo();
  try {
    await handleDaemonPull(['--output-dir', outputDir], io);
  } finally {
    globalThis.fetch = origFetch;
  }
  expect(err.some((l) => l.includes('mismatch'))).toBe(false);
});

test('handleDaemonPull --json emits JSON summary on success', async () => {
  await writeCreds();
  await setBrainId('brain-abc');
  const content = Buffer.from('{"ok":1}');
  const origFetch = globalThis.fetch;
  // @ts-ignore
  globalThis.fetch = async (url: string) => {
    if (url.includes('/v1/sync/transcripts/pull')) {
      return { ok: true, json: async () => ({ data: { transcripts: [
        { key: 'k', cli: 'claude', filename: 'f.jsonl', relative_path: 'f.jsonl', machine_id: 'm1', size: content.length },
      ] } }) };
    }
    if (url.includes('/v1/sync/transcripts/download')) {
      return { ok: true, arrayBuffer: async () => content.buffer };
    }
    throw new Error(`Unexpected: ${url}`);
  };
  const outputDir = path.join(tmpDir, 'out-json');
  const { io, out } = captureIo();
  try {
    await handleDaemonPull(['--output-dir', outputDir, '--json'], io);
  } finally {
    globalThis.fetch = origFetch;
  }
  const jsonLine = out.find((l) => l.startsWith('{'));
  expect(jsonLine).toBeDefined();
  const parsed = JSON.parse(jsonLine!);
  expect(parsed.downloaded).toBe(1);
  expect(parsed.failed).toBe(0);
  expect(Array.isArray(parsed.files)).toBe(true);
});

test('handleDaemonPull --json emits JSON on empty result', async () => {
  await writeCreds();
  await setBrainId('brain-abc');
  const origFetch = globalThis.fetch;
  // @ts-ignore
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: { transcripts: [] } }) });
  const { io, out } = captureIo();
  try {
    await handleDaemonPull(['--json'], io);
  } finally {
    globalThis.fetch = origFetch;
  }
  const jsonLine = out.find((l) => l.startsWith('{'));
  expect(jsonLine).toBeDefined();
  const parsed = JSON.parse(jsonLine!);
  expect(parsed.downloaded).toBe(0);
});

test('handleDaemonPull exits 1 on server error', async () => {
  await writeCreds();
  await setBrainId('brain-abc');

  const origFetch = globalThis.fetch;
  // @ts-ignore
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'internal error' });
  const { io, err } = captureIo();
  const exit = stubExit();
  try {
    await handleDaemonPull([], io).catch(() => {});
  } finally {
    globalThis.fetch = origFetch;
    exit.restore();
  }
  expect(exit.exited || err.some((l) => l.includes('Failed to list'))).toBe(true);
});
