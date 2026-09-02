import { expect, test } from 'bun:test';
import { InsightExtractor } from '../lib/analysis/insight-extractor.js';
import { createAnalysisPrivacyPolicy } from '../lib/analysis/privacy-policy.js';
import { TranscriptAnalyzer } from '../lib/analysis/transcript-analyzer.js';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const canary = 'ANALYSIS_REATTACH_CANARY_1a2b3c';
const policy = () => createAnalysisPrivacyPolicy([], { snapshot: { state: 'loaded', values: new Set([canary]), sourceMap: new Map([[canary, 'env']]), derivedValues: new Set(), derivedSourceMap: new Map(), health: {} } });
const transcript = (content = 'safe local note') => ({ sessionId: 'opaque-session-id', startTime: '2026-08-10T00:00:00.000Z', cli: 'codex', cwd: '/private/cwd', gitBranch: 'private-branch', messages: [{ type: 'user', content }], filesModified: [{ path: '/private/file' }], errors: [], summary: { durationMs: 6_000, messageCount: 11 } });
const completion = JSON.stringify({ technicalLearnings: ['safe learning'], skillsDeveloped: [], mistakesAndCorrections: [], strategicDecisions: [], patterns: [], summary: 'safe summary' });

test('verified extractor sends only an allowlisted request and returns a safe memory envelope', async () => {
  const captured = [];
  const extractor = new InsightExtractor({ appId: 'app', apiKey: 'key', mechUrl: 'https://loopback.invalid', fetchImpl: async (url, init) => { captured.push({ url, headers: init.headers, body: init.body }); return new Response(JSON.stringify({ completion }), { status: 200 }); } }, { policy: policy() });
  const result = await extractor.extractInsights({ ...transcript(), toolUses: [{ result: canary }] });
  expect(result.insights.summary).toBe('safe summary');
  expect(captured[0].url).toBe('https://loopback.invalid/api/apps/app/complete');
  expect(JSON.stringify(captured)).not.toContain('/private/cwd');
  expect(JSON.stringify(captured)).not.toContain('private-branch');
  expect(JSON.stringify(captured)).not.toContain('opaque-session-id');
  expect(JSON.stringify(captured)).not.toContain(canary);
  expect(Object.keys(JSON.parse(captured[0].body)).sort()).toEqual(['max_tokens', 'model', 'prompt', 'temperature']);
  expect(Object.keys(captured[0].headers).sort()).toEqual(['Content-Type', 'x-api-key']);
});

test('blocked source and echoed completion make zero unsafe progress', async () => {
  let calls = 0;
  const extractor = new InsightExtractor({ appId: 'app', apiKey: 'key', fetchImpl: async () => { calls++; return new Response(JSON.stringify({ completion }), { status: 200 }); } }, { policy: policy() });
  expect(await extractor.extractInsights(transcript('-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----'))).toEqual({ state: 'blocked_redaction', code: 'analysis_input_unprovable' });
  expect(calls).toBe(0);
  const echo = new InsightExtractor({ appId: 'app', apiKey: 'key', fetchImpl: async () => { calls++; return new Response(JSON.stringify({ completion: completion.replace('safe learning', canary) }), { status: 200 }); } }, { policy: policy() });
  expect(await echo.extractInsights(transcript())).toEqual({ state: 'blocked_response', code: 'analysis_response_unprovable' });
});

test('missing local session context blocks before egress while an outer session id stays local-only', async () => {
  let calls = 0;
  const extractor = new InsightExtractor({ appId: 'app', apiKey: 'key', fetchImpl: async () => { calls++; return new Response(JSON.stringify({ completion }), { status: 200 }); } }, { policy: policy() });
  const withoutSession = { ...transcript(), sessionId: undefined };
  expect(await extractor.extractInsights(withoutSession)).toEqual({ state: 'blocked_redaction', code: 'analysis_context_unprovable' });
  expect(calls).toBe(0);
  expect((await extractor.extractInsights(withoutSession, { sessionId: 'outer-session-id' })).analysisId).toHaveLength(16);
  expect(calls).toBe(1);
});

test('numeric parser timestamps remain the local memory-log date', async () => {
  const extractor = new InsightExtractor({ appId: 'app', apiKey: 'key', fetchImpl: async () => new Response(JSON.stringify({ completion }), { status: 200 }) }, { policy: policy() });
  const result = await extractor.extractInsights({ ...transcript(), startTime: 1_786_060_800_000 });
  expect(result.startTime).toBe(1_786_060_800_000);
});

test('scheduled analyzer uses the same verified path and persists no raw transcript context', async () => {
  const basePath = await fs.mkdtemp(path.join(os.tmpdir(), 'analysis-reattachment-'));
  const captured = [];
  try {
    const analyzer = new TranscriptAnalyzer({
      basePath,
      projectPath: basePath,
      llmConfig: {
        appId: 'app', apiKey: 'key', mechUrl: 'https://loopback.invalid',
        fetchImpl: async (url, init) => {
          captured.push({ url, headers: init.headers, body: init.body });
          return new Response(JSON.stringify({ completion }), { status: 200 });
        },
      },
    });
    analyzer.extractor.policy = policy();
    analyzer.parser.parseTranscript = async () => transcript('safe scheduled note');
    const events = [];
    analyzer.on('session:analyzed', (event) => events.push(event));

    await analyzer.analyzeSession({ sessionId: 'opaque-session-id', path: '/private/transcript.jsonl', cli: 'codex' });

    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty('sessionId');
    expect(events[0]).not.toHaveProperty('dailyLogPath');
    expect(events[0]).not.toHaveProperty('memoryPath');
    expect(events[0].analysisId).toHaveLength(16);
    expect(events[0].dailyLogWritten).toBe(true);
    const daily = await fs.readFile(path.join(basePath, 'memory/daily/2026-08-10.md'), 'utf8');
    expect(`${JSON.stringify(captured)}${daily}`).not.toContain('opaque-session-id');
    expect(`${JSON.stringify(captured)}${daily}`).not.toContain('/private');
    expect(`${JSON.stringify(captured)}${daily}`).not.toContain(canary);
  } finally {
    await fs.rm(basePath, { recursive: true, force: true });
  }
});

test('scheduled analyzer migrates legacy raw state IDs into opaque session references', async () => {
  const basePath = await fs.mkdtemp(path.join(os.tmpdir(), 'analysis-state-migration-'));
  try {
    await fs.writeFile(path.join(basePath, '.transcript-analyzer-state.json'), JSON.stringify({ processedSessions: ['legacy-session-id'] }));
    const analyzer = new TranscriptAnalyzer({ basePath, projectPath: basePath, llmConfig: { appId: 'app', apiKey: 'key' } });
    await analyzer.loadProcessedSessions();
    expect(analyzer.processedSessions.has('legacy-session-id')).toBe(false);
    expect([...analyzer.processedSessions]).toHaveLength(1);
    expect([...analyzer.processedSessions][0]).toMatch(/^ref_[a-f0-9]{16}$/);
    expect(await fs.readFile(path.join(basePath, '.transcript-analyzer-state.json'), 'utf8')).not.toContain('legacy-session-id');
  } finally {
    await fs.rm(basePath, { recursive: true, force: true });
  }
});

test('remote processed-session references round-trip without rehashing', async () => {
  const ref = 'ref_0123456789abcdef';
  const analyzer = new TranscriptAnalyzer({
    storageBackend: 'mech', agentId: 'test.agent',
    llmConfig: { appId: 'app', apiKey: 'key' },
    mechClient: { loadProcessedSessions: async () => [ref], saveProcessedSessions: async () => {} },
  });
  await analyzer.loadProcessedSessions();
  expect([...analyzer.processedSessions]).toEqual([ref]);
});
