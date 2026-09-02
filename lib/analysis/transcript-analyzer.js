/**
 * Transcript Analyzer
 *
 * Automatically analyzes session transcripts and extracts insights for
 * autonomous self-improvement.
 *
 * Triggers:
 * - On new transcript detection (watches ~/.claude/projects/)
 * - On schedule (daily analysis)
 *
 * Workflow:
 * 1. Detect new/recent transcripts
 * 2. Parse transcript data
 * 3. Extract insights using LLM
 * 4. Write to memory files
 * 5. Memory sync daemon picks up changes
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';
import { createHash } from 'node:crypto';
import { TranscriptParser } from './transcript-parser.js';
import { InsightExtractor } from './insight-extractor.js';
import { MemoryWriter } from './memory-writer.js';

const toSessionRef = (sessionId) => `ref_${createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 16)}`;
const normalizeProcessedSessions = (state) => new Set(
  state?.sessionRefSchema === 1 && Array.isArray(state.processedSessionRefs)
    ? state.processedSessionRefs.filter((value) => typeof value === 'string' && /^ref_[a-f0-9]{16}$/.test(value))
    : (Array.isArray(state?.processedSessions) ? state.processedSessions : []).filter((value) => typeof value === 'string').map(toSessionRef)
);
const isCurrentState = (state) => state?.sessionRefSchema === 1 && Array.isArray(state.processedSessionRefs);
const withSessionRefs = (state, refs) => {
  const { processedSessions: _legacy, ...rest } = state || {};
  return { ...rest, sessionRefSchema: 1, processedSessionRefs: Array.from(refs), lastSaved: Date.now() };
};
const normalizeRemoteProcessedSessions = (values) => new Set(
  (values || []).filter((value) => typeof value === 'string').map((value) => /^ref_[a-f0-9]{16}$/.test(value) ? value : toSessionRef(value))
);
const stableErrorCode = (error) => typeof error?.code === 'string' && /^(analysis_|ANALYSIS_|E[A-Z0-9_]+$)/.test(error.code)
  ? error.code : 'ANALYSIS_FAILED';
const publicAnalysisError = (error) => Object.assign(new Error('Transcript analysis failed.'), { code: stableErrorCode(error) });

export class TranscriptAnalyzer extends EventEmitter {
  constructor(options = {}) {
    super();

    this.basePath = options.basePath || process.cwd();
    this.projectPath = options.projectPath || this.basePath;
    this.llmClient = options.llmClient;
    this.storageBackend = options.storageBackend || 'local';
    this.mechClient = options.mechClient || null;
    this.agentId = options.agentId || '';
    this.checkIntervalMs = options.checkIntervalMs || 60 * 60 * 1000; // 1 hour default

    const llmConfig = options.llmConfig || this.llmClient;
    if (!llmConfig?.appId || !llmConfig?.apiKey) {
      throw new Error('TranscriptAnalyzer requires llmConfig with appId and apiKey');
    }

    this.parser = new TranscriptParser();
    this.extractor = new InsightExtractor(llmConfig, { projectRoots: [this.projectPath] });
    this.writer = new MemoryWriter({ basePath: this.basePath });

    this.processedSessions = new Set(); // Track processed session IDs
    this.running = false;
    this.checkTimer = null;

    this.stats = {
      sessionsAnalyzed: 0,
      insightsExtracted: 0,
      memoryFilesWritten: 0,
      lastAnalysisAt: null,
      errors: 0
    };
  }

  /**
   * Start the analyzer
   */
  async start() {
    if (this.running) {
      console.log('[TranscriptAnalyzer] Already running');
      return;
    }

    console.log('[TranscriptAnalyzer] Starting...');
    this.running = true;

    // Load previously processed sessions
    await this.loadProcessedSessions();

    // Run initial analysis
    await this.analyzeRecentSessions();

    // Schedule periodic checks
    this.scheduleNextCheck();

    this.emit('started');
    console.log('[TranscriptAnalyzer] Started successfully');
  }

  /**
   * Stop the analyzer
   */
  async stop() {
    if (!this.running) {
      return;
    }

    console.log('[TranscriptAnalyzer] Stopping...');
    this.running = false;

    // Clear timer
    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
      this.checkTimer = null;
    }

    // Save processed sessions
    await this.saveProcessedSessions();

    this.emit('stopped');
    console.log('[TranscriptAnalyzer] Stopped');
  }

  /**
   * Analyze recent sessions (default: last 24 hours)
   */
  async analyzeRecentSessions(hoursBack = 24) {
    console.log(`[TranscriptAnalyzer] Analyzing sessions from last ${hoursBack}h`);

    try {
      const transcripts = this.storageBackend === 'mech'
        ? await this.listRemoteTranscripts(hoursBack)
        : await this.parser.listTranscripts(this.projectPath);

      if (transcripts.length === 0) {
        console.log('[TranscriptAnalyzer] No transcripts found');
        return;
      }

      // Filter to recent transcripts
      const cutoffTime = Date.now() - (hoursBack * 60 * 60 * 1000);
      const transcriptsWithStats = this.storageBackend === 'mech'
        ? transcripts.map((t) => ({ ...t, mtime: t.mtime ? new Date(t.mtime) : new Date() }))
        : await Promise.all(
            transcripts.map(async (t) => {
              const stats = await fs.stat(t.path);
              return { ...t, mtime: stats.mtime };
            })
          );

      const recentTranscripts = transcriptsWithStats
        .filter(t => t.mtime.getTime() > cutoffTime)
        .filter(t => !this.processedSessions.has(toSessionRef(t.sessionId)))
        .sort((a, b) => a.mtime - b.mtime); // Oldest first

      console.log(`[TranscriptAnalyzer] Found ${recentTranscripts.length} new sessions to analyze`);

      // Analyze each session
      for (const transcript of recentTranscripts) {
        await this.analyzeSession(transcript);
      }

      this.stats.lastAnalysisAt = Date.now();
      this.emit('analysis:complete', { sessionsAnalyzed: recentTranscripts.length });
    } catch (err) {
      const publicError = publicAnalysisError(err);
      console.error('[TranscriptAnalyzer] Error analyzing recent sessions', { code: publicError.code });
      this.stats.errors++;
      this.emit('error', publicError);
    }
  }

  /**
   * Analyze a single session
   */
  async analyzeSession(transcript) {
    const { sessionId, path: transcriptPath, cli = 'claude' } = transcript;
    const sessionRef = toSessionRef(sessionId);

    try {
      console.log(`[TranscriptAnalyzer] Analyzing session ${sessionRef}...`);

      // Parse transcript
      const data = await this.parser.parseTranscript(transcriptPath, true, { cli });

      // Check if session is significant enough to analyze
      if (!this.extractor.isSignificant(data)) {
        console.log(`[TranscriptAnalyzer] Session ${sessionRef} not significant, skipping`);
        this.processedSessions.add(sessionRef);
        return;
      }

      // Extract insights using LLM
      const insights = await this.extractor.extractInsights(data, { sessionId });
      if (insights?.state === 'blocked_redaction' || insights?.state === 'blocked_response') {
        const error = new Error('Transcript analysis response was blocked by the privacy boundary.');
        error.code = insights.code;
        throw error;
      }

      console.log(`[TranscriptAnalyzer] Extracted insights:`, {
        technicalLearnings: insights.insights.technicalLearnings.length,
        skillsDeveloped: insights.insights.skillsDeveloped.length,
        mistakes: insights.insights.mistakesAndCorrections.length,
        decisions: insights.insights.strategicDecisions.length,
        patterns: insights.insights.patterns.length
      });

      // Write to memory files
      const dailyLogPath = await this.writer.writeDailyLog(insights);
      const memoryPath = await this.writer.updateMemoryMd(insights);

      // Track as processed
      this.processedSessions.add(sessionRef);

      // Update stats
      this.stats.sessionsAnalyzed++;
      this.stats.insightsExtracted += (
        insights.insights.technicalLearnings.length +
        insights.insights.skillsDeveloped.length +
        insights.insights.mistakesAndCorrections.length +
        insights.insights.strategicDecisions.length +
        insights.insights.patterns.length
      );
      if (dailyLogPath) this.stats.memoryFilesWritten++;

      this.emit('session:analyzed', {
        analysisId: insights.analysisId,
        insightsCount: this.stats.insightsExtracted,
        dailyLogWritten: Boolean(dailyLogPath),
        memoryUpdated: Boolean(memoryPath),
      });

      console.log(`[TranscriptAnalyzer] ✅ Session ${sessionRef} analyzed and logged`);
    } catch (err) {
      const publicError = publicAnalysisError(err);
      console.error('[TranscriptAnalyzer] Failed to analyze session', sessionRef, {
        code: publicError.code,
      });
      this.stats.errors++;
      this.emit('session:error', { sessionRef, error: publicError });
    }
  }

  /**
   * Schedule next check
   */
  scheduleNextCheck() {
    if (!this.running) return;

    this.checkTimer = setTimeout(async () => {
      await this.analyzeRecentSessions();
      this.scheduleNextCheck();
    }, this.checkIntervalMs);
  }

  /**
   * Load previously processed sessions from state file
   */
  async loadProcessedSessions() {
    if (this.storageBackend === 'mech' && this.mechClient?.loadProcessedSessions) {
      try {
        const ids = await this.mechClient.loadProcessedSessions(this.agentId, this.projectPath);
        this.processedSessions = normalizeRemoteProcessedSessions(ids);
      } catch (err) {
        console.error('[TranscriptAnalyzer] Error loading remote processed sessions');
      }
      return;
    }

    const statePath = path.join(this.basePath, '.transcript-analyzer-state.json');

    try {
      const content = await fs.readFile(statePath, 'utf-8');
      const state = JSON.parse(content);

      if (state.processedSessions || state.processedSessionRefs) {
        this.processedSessions = normalizeProcessedSessions(state);
        if (!isCurrentState(state)) {
          const temporaryPath = `${statePath}.${process.pid}.tmp`;
          await fs.writeFile(temporaryPath, JSON.stringify(withSessionRefs(state, this.processedSessions), null, 2), 'utf-8');
          await fs.rename(temporaryPath, statePath);
        }
        console.log(`[TranscriptAnalyzer] Loaded ${this.processedSessions.size} processed sessions`);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('[TranscriptAnalyzer] Error loading state');
      }
    }
  }

  /**
   * Save processed sessions to state file
   */
  async saveProcessedSessions() {
    if (this.storageBackend === 'mech' && this.mechClient?.saveProcessedSessions) {
      try {
        await this.mechClient.saveProcessedSessions(
          this.agentId,
          this.projectPath,
          Array.from(this.processedSessions),
          this.stats
        );
    } catch (err) {
        console.error('[TranscriptAnalyzer] Error saving remote processed sessions');
      }
      return;
    }

    const statePath = path.join(this.basePath, '.transcript-analyzer-state.json');

    const state = {
      sessionRefSchema: 1,
      processedSessionRefs: Array.from(this.processedSessions),
      stats: this.stats,
      lastSaved: Date.now()
    };

    try {
      await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');
      console.log(`[TranscriptAnalyzer] Saved state (${this.processedSessions.size} sessions)`);
    } catch (err) {
      console.error('[TranscriptAnalyzer] Error saving state');
    }
  }

  /**
   * Get current stats
   */
  getStats() {
    return { ...this.stats };
  }

  async listRemoteTranscripts(hoursBack) {
    if (!this.mechClient?.listTranscripts) {
      return [];
    }
    return this.mechClient.listTranscripts({
      projectPath: this.projectPath,
      agentId: this.agentId,
      hoursBack,
    });
  }
}
