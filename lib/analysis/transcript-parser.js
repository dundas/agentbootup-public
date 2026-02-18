/**
 * Transcript Parser for Claude Code Sessions
 *
 * Parses .jsonl transcript files from ~/.claude/projects/
 * and extracts structured session data for analysis.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';

export class TranscriptParser {
  constructor() {
    this.projectsDir = path.join(os.homedir(), '.claude', 'projects');
    this.cache = new Map(); // Cache parsed transcripts
  }

  /**
   * Parse a transcript file with caching
   */
  async parseTranscript(transcriptPath, useCache = true) {
    // Check cache first
    if (useCache && this.cache.has(transcriptPath)) {
      const cached = this.cache.get(transcriptPath);
      try {
        const stats = await fs.stat(transcriptPath);
        if (stats.mtime.getTime() === cached.mtime) {
          return cached.data;
        }
      } catch (err) {
        this.cache.delete(transcriptPath);
      }
    }

    // Parse transcript
    const content = await fs.readFile(transcriptPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    const events = lines.map(line => {
      try {
        return JSON.parse(line);
      } catch (err) {
        return null;
      }
    }).filter(Boolean);

    const data = this.extractStructuredData(events);

    // Cache result
    if (useCache) {
      try {
        const stats = await fs.stat(transcriptPath);
        this.cache.set(transcriptPath, {
          data,
          mtime: stats.mtime.getTime()
        });
      } catch (err) {
        // Ignore cache errors
      }
    }

    return data;
  }

  /**
   * Extract structured data from transcript events
   */
  extractStructuredData(events) {
    const data = {
      sessionId: null,
      startTime: null,
      endTime: null,
      cwd: null,
      gitBranch: null,
      messages: [],
      toolUses: [],
      filesModified: [],
      errors: [],
      summary: null
    };

    for (const event of events) {
      // Session metadata
      if (event.sessionId && !data.sessionId) data.sessionId = event.sessionId;
      if (event.cwd && !data.cwd) data.cwd = event.cwd;
      if (event.gitBranch && !data.gitBranch) data.gitBranch = event.gitBranch;

      if (event.timestamp) {
        if (!data.startTime || event.timestamp < data.startTime) {
          data.startTime = event.timestamp;
        }
        if (!data.endTime || event.timestamp > data.endTime) {
          data.endTime = event.timestamp;
        }
      }

      // Extract messages
      if (event.type === 'user' && event.message) {
        const content = typeof event.message.content === 'string'
          ? event.message.content
          : JSON.stringify(event.message.content);

        data.messages.push({
          type: 'user',
          content,
          timestamp: event.timestamp,
          uuid: event.uuid
        });
      } else if (event.type === 'assistant' && event.message) {
        let textContent;
        if (Array.isArray(event.message.content)) {
          textContent = event.message.content
            ?.filter(c => c.type === 'text')
            ?.map(c => c.text)
            ?.join('\n');
        } else if (typeof event.message.content === 'string') {
          textContent = event.message.content;
        }

        if (textContent) {
          data.messages.push({
            type: 'assistant',
            content: textContent,
            timestamp: event.timestamp,
            uuid: event.uuid
          });
        }
      }

      // Extract tool uses
      if (event.type === 'tool_use') {
        data.toolUses.push({
          tool: event.tool,
          parameters: event.parameters,
          timestamp: event.timestamp
        });
      }

      // Extract file modifications
      if (event.type === 'tool_result' && event.toolName) {
        if (['Edit', 'Write'].includes(event.toolName) && event.result?.file_path) {
          data.filesModified.push({
            path: event.result.file_path,
            action: event.toolName,
            timestamp: event.timestamp
          });
        }
      }

      // Extract errors
      if (event.type === 'error' || (event.result && event.result.error)) {
        data.errors.push({
          message: event.error || event.result.error,
          timestamp: event.timestamp
        });
      }
    }

    // Generate summary
    data.summary = this.generateSummary(data);

    return data;
  }

  /**
   * Generate session summary
   */
  generateSummary(data) {
    const userMessages = data.messages.filter(m => m.type === 'user');
    const duration = data.endTime && data.startTime
      ? new Date(data.endTime) - new Date(data.startTime)
      : 0;

    return {
      messageCount: data.messages.length,
      userMessageCount: userMessages.length,
      toolUseCount: data.toolUses.length,
      filesModifiedCount: data.filesModified.length,
      errorCount: data.errors.length,
      durationMs: duration,
      durationFormatted: this.formatDuration(duration)
    };
  }

  /**
   * Format duration in human-readable form
   */
  formatDuration(ms) {
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);

    const parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

    return parts.join(' ');
  }

  /**
   * List transcripts for a project
   */
  async listTranscripts(projectPath) {
    const normalizedPath = projectPath.replace(/^[/\\]/, '').replace(/[/\\]/g, '-');
    const projectDir = path.join(this.projectsDir, normalizedPath);

    // Guard against directory traversal
    const resolved = path.resolve(projectDir);
    if (!resolved.startsWith(path.resolve(this.projectsDir))) {
      throw new Error('Invalid project path: attempted directory traversal');
    }

    try {
      const files = await fs.readdir(projectDir);
      const transcripts = files
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({
          path: path.join(projectDir, f),
          sessionId: f.replace('.jsonl', ''),
          name: f
        }));

      return transcripts;
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  /**
   * Get most recent transcript for a project
   */
  async getMostRecentTranscript(projectPath) {
    const transcripts = await this.listTranscripts(projectPath);
    if (transcripts.length === 0) return null;

    const transcriptsWithStats = (await Promise.all(
      transcripts.map(async (t) => {
        try {
          const stats = await fs.stat(t.path);
          return { ...t, mtime: stats.mtime };
        } catch {
          // File deleted between listing and stating - skip
          return null;
        }
      })
    )).filter(t => t !== null);

    if (transcriptsWithStats.length === 0) return null;

    transcriptsWithStats.sort((a, b) => b.mtime - a.mtime);
    return transcriptsWithStats[0];
  }

  /**
   * Extract key topics from session
   */
  extractKeyTopics(data) {
    const userMessages = data.messages
      .filter(m => m.type === 'user')
      .map(m => m.content)
      .join(' ');

    const words = userMessages.toLowerCase().split(/\s+/);
    const commonWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should', 'could', 'may', 'might', 'must', 'can', 'what', 'when', 'where', 'who', 'why', 'how', 'this', 'that', 'these', 'those', 'i', 'you', 'we', 'they', 'it', 'he', 'she']);

    const wordFreq = {};
    for (const word of words) {
      if (word.length > 3 && !commonWords.has(word)) {
        wordFreq[word] = (wordFreq[word] || 0) + 1;
      }
    }

    return Object.entries(wordFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word]) => word);
  }
}
