import { afterEach, expect, test } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { InsightExtractor } from '../lib/analysis/insight-extractor.js';
import { TranscriptAnalyzer } from '../lib/analysis/transcript-analyzer.js';
import { createAnalysisPrivacyPolicy } from '../lib/analysis/privacy-policy.js';

const temporaryDirectories = new Set();

async function temporaryDirectory(prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all([...temporaryDirectories].map((directory) => fs.rm(directory, { recursive: true, force: true })));
  temporaryDirectories.clear();
});

const significantTranscript = Object.freeze({
  sessionId: 'session-with-local-only-content',
  startTime: '2026-08-10T00:00:00.000Z',
  cwd: '/local/private/project',
  gitBranch: 'private-branch',
  cli: 'codex',
  messages: [{ type: 'user', content: 'token=private-local-only-value' }],
  filesModified: [{ path: '/local/private/project/.env' }],
  errors: [],
  summary: { durationFormatted: '10m', durationMs: 600_000, messageCount: 11 },
});

test('scheduled analyzer fails closed without a usable policy and does not write memory', async () => {
  const basePath = await temporaryDirectory('transcript-analysis-contained-');
  let completeCalls = 0;
  const analyzer = new TranscriptAnalyzer({
    basePath,
    projectPath: basePath,
    llmConfig: { appId: 'test-app', apiKey: 'test-key', fetchImpl: async () => { completeCalls++; } },
  });
  analyzer.extractor.policy = createAnalysisPrivacyPolicy([], { snapshot: { state: 'failed', health: {} } });
  analyzer.parser.parseTranscript = async () => significantTranscript;
  const errors = [];
  analyzer.on('session:error', (event) => errors.push(event));

  await analyzer.analyzeSession({ sessionId: 'session-with-local-only-content', path: '/unused', cli: 'codex' });

  expect(completeCalls).toBe(0);
  await expect(fs.stat(path.join(basePath, 'memory'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(analyzer.processedSessions.has('session-with-local-only-content')).toBe(false);
  expect(analyzer.stats.errors).toBe(1);
  expect(errors).toHaveLength(1);
  expect(errors[0].error.code).toBe('analysis_policy_unavailable');
  expect(errors[0]).not.toHaveProperty('sessionId');
  expect(errors[0].sessionRef).toMatch(/^ref_[a-f0-9]{16}$/);
});

test('CLI rejects analysis without credentials before transcript reads or state writes', async () => {
  const projectPath = await temporaryDirectory('transcript-analysis-cli-contained-');
  const scriptPath = path.resolve(import.meta.dirname, '../analyze-transcripts.mjs');
  const result = Bun.spawnSync([process.execPath, scriptPath, '--project', projectPath, '--dry-run'], {
    cwd: projectPath,
    env: { PATH: process.env.PATH ?? '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;

  expect(result.exitCode).toBe(1);
  expect(output).toContain('MECH_APP_ID and MECH_API_KEY');
  await expect(fs.stat(path.join(projectPath, '.transcript-analyzer-state.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('CLI help and stats stay available because they do not analyze transcripts', async () => {
  const projectPath = await temporaryDirectory('transcript-analysis-cli-stats-');
  const scriptPath = path.resolve(import.meta.dirname, '../analyze-transcripts.mjs');
  const help = Bun.spawnSync([process.execPath, scriptPath, '--help'], { stdout: 'pipe', stderr: 'pipe' });
  const stats = Bun.spawnSync([process.execPath, scriptPath, '--project', projectPath, '--stats'], {
    cwd: projectPath,
    env: { PATH: process.env.PATH ?? '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect(help.exitCode).toBe(0);
  expect(new TextDecoder().decode(help.stdout)).toContain('analyze-transcripts');
  expect(new TextDecoder().decode(help.stdout)).toContain('bounded, deterministic-redacted projection');
  expect(stats.exitCode).toBe(0);
  expect(new TextDecoder().decode(stats.stdout)).toContain('No analysis state found');
  await expect(fs.stat(path.join(projectPath, '.transcript-analyzer-state.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('CLI reset with no transcripts leaves no stale state', async () => {
  const projectPath = await temporaryDirectory('transcript-analysis-cli-reset-');
  const statePath = path.join(projectPath, '.transcript-analyzer-state.json');
  await fs.writeFile(statePath, JSON.stringify({ processedSessions: ['existing-session'] }));
  const scriptPath = path.resolve(import.meta.dirname, '../analyze-transcripts.mjs');
  const result = Bun.spawnSync([process.execPath, scriptPath, '--project', projectPath, '--reset'], {
    cwd: projectPath,
    env: { PATH: process.env.PATH ?? '', MECH_APP_ID: 'test-app', MECH_API_KEY: 'test-key' },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect(result.exitCode).toBe(0);
  await expect(fs.stat(statePath)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('CLI eagerly migrates legacy raw session state even when there are no transcripts', async () => {
  const projectPath = await temporaryDirectory('transcript-analysis-cli-migration-');
  const statePath = path.join(projectPath, '.transcript-analyzer-state.json');
  await fs.writeFile(statePath, JSON.stringify({ processedSessions: ['legacy-session-id'], stats: { insightsExtracted: 7 } }));
  const scriptPath = path.resolve(import.meta.dirname, '../analyze-transcripts.mjs');
  const result = Bun.spawnSync([process.execPath, scriptPath, '--project', projectPath], {
    cwd: projectPath,
    env: { PATH: process.env.PATH ?? '', MECH_APP_ID: 'test-app', MECH_API_KEY: 'test-key' },
    stdout: 'pipe', stderr: 'pipe',
  });
  expect(result.exitCode).toBe(0);
  const migrated = await fs.readFile(statePath, 'utf8');
  expect(migrated).not.toContain('legacy-session-id');
  expect(migrated).toContain('ref_');
  expect(migrated).toContain('insightsExtracted');
});

test('CLI dry-run never migrates legacy state', async () => {
  const projectPath = await temporaryDirectory('transcript-analysis-cli-dry-run-migration-');
  const statePath = path.join(projectPath, '.transcript-analyzer-state.json');
  await fs.writeFile(statePath, JSON.stringify({ processedSessions: ['legacy-session-id'] }));
  const scriptPath = path.resolve(import.meta.dirname, '../analyze-transcripts.mjs');
  const result = Bun.spawnSync([process.execPath, scriptPath, '--project', projectPath, '--dry-run'], {
    cwd: projectPath,
    env: { PATH: process.env.PATH ?? '', MECH_APP_ID: 'test-app', MECH_API_KEY: 'test-key' },
    stdout: 'pipe', stderr: 'pipe',
  });
  expect(result.exitCode).toBe(0);
  expect(await fs.readFile(statePath, 'utf8')).toContain('legacy-session-id');
});
