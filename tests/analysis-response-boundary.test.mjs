import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAnalysisPrivacyPolicy } from '../lib/analysis/privacy-policy.js';
import { createVerifiedInsightEnvelope } from '../lib/analysis/insight-response-boundary.js';
import { MemoryWriter } from '../lib/analysis/memory-writer.js';

const canary = 'AGENTBOOTUP_RESPONSE_CANARY_3e8c2b';
const policy = () => createAnalysisPrivacyPolicy([], { snapshot: { state: 'loaded', values: new Set([canary]), sourceMap: new Map([[canary, 'env']]), derivedValues: new Set(), derivedSourceMap: new Map(), health: {} } });
const valid = () => JSON.stringify({ technicalLearnings: ['use bounded schemas'], skillsDeveloped: [], mistakesAndCorrections: [], strategicDecisions: [], patterns: [], summary: 'safe result' });
const context = { sessionId: 'private-session-id', startTime: 1_700_000_000_000, cli: 'codex', durationMs: 2_000, messageCount: 3, filesModified: 1, errors: 0 };

test('accepts only the closed bounded response schema and omits raw context', () => {
  const envelope = createVerifiedInsightEnvelope(valid(), context, policy());
  expect(Object.keys(envelope).sort()).toEqual(['analysisId', 'insights', 'metadata', 'startTime']);
  expect(JSON.stringify(envelope)).not.toContain('private-session-id');
  expect(envelope.insights.summary).toBe('safe result');
});

test('rejects canary echoes and malformed or unknown response fields', () => {
  const echoed = JSON.stringify({ technicalLearnings: [canary], skillsDeveloped: [], mistakesAndCorrections: [], strategicDecisions: [], patterns: [], summary: 'safe' });
  expect(createVerifiedInsightEnvelope(echoed, context, policy())).toEqual({ state: 'blocked_response', code: 'analysis_response_unprovable' });
  expect(createVerifiedInsightEnvelope(JSON.stringify({ ...JSON.parse(valid()), extra: 'nope' }), context, policy())).toEqual({ state: 'blocked_response', code: 'analysis_response_invalid' });
  expect(createVerifiedInsightEnvelope('{bad json', context, policy())).toEqual({ state: 'blocked_response', code: 'analysis_response_invalid' });
});

test('MemoryWriter rejects unverified data and does not create convergent memory files', async () => {
  const basePath = await fs.mkdtemp(path.join(os.tmpdir(), 'analysis-response-'));
  const writer = new MemoryWriter({ basePath });
  await expect(writer.writeDailyLog({ insights: JSON.parse(valid()) })).rejects.toMatchObject({ code: 'ANALYSIS_RESPONSE_UNVERIFIED' });
  await expect(fs.stat(path.join(basePath, 'memory'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('MemoryWriter persists only the verified envelope without raw session context', async () => {
  const basePath = await fs.mkdtemp(path.join(os.tmpdir(), 'analysis-response-'));
  const envelope = createVerifiedInsightEnvelope(valid(), context, policy());
  const writer = new MemoryWriter({ basePath });
  const dailyPath = await writer.writeDailyLog(envelope);
  const persisted = await fs.readFile(dailyPath, 'utf8');

  expect(persisted).toContain(envelope.analysisId);
  expect(persisted).toContain('safe result');
  expect(persisted).not.toContain('private-session-id');
});
