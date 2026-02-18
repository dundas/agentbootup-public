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
import { TranscriptParser } from './transcript-parser.js';
import { InsightExtractor } from './insight-extractor.js';
import { MemoryWriter } from './memory-writer.js';

export class TranscriptAnalyzer extends EventEmitter {
  constructor(options = {}) {
    super();

    this.basePath = options.basePath || process.cwd();
    this.projectPath = options.projectPath || this.basePath;
    this.llmClient = options.llmClient; // Mech LLMs API client (required)
    this.checkIntervalMs = options.checkIntervalMs || 60 * 60 * 1000; // 1 hour default

    if (!this.llmClient) {
      throw new Error('TranscriptAnalyzer requires llmClient');
    }

    this.parser = new TranscriptParser();
    this.extractor = new InsightExtractor(this.llmClient);
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
      // Get all transcripts for project
      const transcripts = await this.parser.listTranscripts(this.projectPath);

      if (transcripts.length === 0) {
        console.log('[TranscriptAnalyzer] No transcripts found');
        return;
      }

      // Filter to recent transcripts
      const cutoffTime = Date.now() - (hoursBack * 60 * 60 * 1000);
      const transcriptsWithStats = await Promise.all(
        transcripts.map(async (t) => {
          const stats = await fs.stat(t.path);
          return { ...t, mtime: stats.mtime };
        })
      );

      const recentTranscripts = transcriptsWithStats
        .filter(t => t.mtime.getTime() > cutoffTime)
        .filter(t => !this.processedSessions.has(t.sessionId))
        .sort((a, b) => a.mtime - b.mtime); // Oldest first

      console.log(`[TranscriptAnalyzer] Found ${recentTranscripts.length} new sessions to analyze`);

      // Analyze each session
      for (const transcript of recentTranscripts) {
        await this.analyzeSession(transcript);
      }

      this.stats.lastAnalysisAt = Date.now();
      this.emit('analysis:complete', { sessionsAnalyzed: recentTranscripts.length });
    } catch (err) {
      console.error('[TranscriptAnalyzer] Error analyzing recent sessions:', err);
      this.stats.errors++;
      this.emit('error', err);
    }
  }

  /**
   * Analyze a single session
   */
  async analyzeSession(transcript) {
    const { sessionId, path: transcriptPath } = transcript;

    try {
      console.log(`[TranscriptAnalyzer] Analyzing session ${sessionId.substring(0, 8)}...`);

      // Parse transcript
      const data = await this.parser.parseTranscript(transcriptPath);

      // Check if session is significant enough to analyze
      if (!this.extractor.isSignificant(data)) {
        console.log(`[TranscriptAnalyzer] Session ${sessionId.substring(0, 8)} not significant, skipping`);
        this.processedSessions.add(sessionId);
        return;
      }

      // Extract insights using LLM
      const insights = await this.extractor.extractInsights(data);

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
      this.processedSessions.add(sessionId);

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
        sessionId,
        insightsCount: this.stats.insightsExtracted,
        dailyLogPath,
        memoryPath
      });

      console.log(`[TranscriptAnalyzer] ✅ Session ${sessionId.substring(0, 8)} analyzed and logged`);
    } catch (err) {
      console.error(`[TranscriptAnalyzer] Failed to analyze session ${sessionId}:`, err);
      this.stats.errors++;
      this.emit('session:error', { sessionId, error: err });
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
    const statePath = path.join(this.basePath, '.transcript-analyzer-state.json');

    try {
      const content = await fs.readFile(statePath, 'utf-8');
      const state = JSON.parse(content);

      if (state.processedSessions) {
        this.processedSessions = new Set(state.processedSessions);
        console.log(`[TranscriptAnalyzer] Loaded ${this.processedSessions.size} processed sessions`);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('[TranscriptAnalyzer] Error loading state:', err);
      }
    }
  }

  /**
   * Save processed sessions to state file
   */
  async saveProcessedSessions() {
    const statePath = path.join(this.basePath, '.transcript-analyzer-state.json');

    const state = {
      processedSessions: Array.from(this.processedSessions),
      stats: this.stats,
      lastSaved: Date.now()
    };

    try {
      await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');
      console.log(`[TranscriptAnalyzer] Saved state (${this.processedSessions.size} sessions)`);
    } catch (err) {
      console.error('[TranscriptAnalyzer] Error saving state:', err);
    }
  }

  /**
   * Get current stats
   */
  getStats() {
    return { ...this.stats };
  }
}
