/**
 * Pattern Detector
 *
 * Core logic for detecting error patterns, success patterns, and decision patterns
 * from transcript history.
 */

import { TranscriptParser } from '../../transcript-query/lib/transcript-parser.js';
import { promises as fs } from 'fs';

export class PatternDetector {
  constructor() {
    this.parser = new TranscriptParser();
  }

  /**
   * Extract patterns from transcripts
   */
  async extractPatterns(directory, options = {}) {
    const {
      last = null,
      since = null,
      errorsOnly = false,
      successesOnly = false,
      decisionsOnly = false
    } = options;

    // Get transcripts
    const transcripts = await this.parser.listTranscripts(directory);
    console.log(`   Found ${transcripts.length} total transcripts`);

    // Filter by date
    let filtered = transcripts;
    if (last) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - last);
      filtered = transcripts.filter(t => new Date(t.timestamp) >= cutoff);
    } else if (since) {
      const cutoffDate = new Date(since);
      filtered = transcripts.filter(t => new Date(t.timestamp) >= cutoffDate);
    }

    console.log(`   Analyzing ${filtered.length} transcripts`);

    // Parse all transcripts
    const parsedData = [];
    for (const transcript of filtered) {
      try {
        const data = await this.parser.parseTranscript(transcript.path);
        parsedData.push({ ...transcript, data });
      } catch (err) {
        console.warn(`   Warning: Failed to parse ${transcript.sessionId}: ${err.message}`);
      }
    }

    // Extract patterns (including compliance dimension added 2026-02-07)
    const patterns = {
      generated: new Date().toISOString(),
      period: {
        days: last || null,
        since: since || null,
        transcripts: parsedData.length
      },
      errors: errorsOnly || !successesOnly && !decisionsOnly ? this.detectErrorPatterns(parsedData) : [],
      successes: successesOnly || !errorsOnly && !decisionsOnly ? this.detectSuccessPatterns(parsedData) : [],
      decisions: decisionsOnly || !errorsOnly && !successesOnly ? this.detectDecisionPatterns(parsedData) : [],
      compliance: this.detectCompliancePatterns(parsedData)
    };

    return patterns;
  }

  /**
   * Detect error patterns
   */
  detectErrorPatterns(transcripts) {
    const errorMap = new Map();

    for (const transcript of transcripts) {
      const { data } = transcript;

      // Find tool errors
      for (const toolUse of data.toolUses || []) {
        if (toolUse.error) {
          const key = `${toolUse.tool}:${this.normalizeError(toolUse.error)}`;

          if (!errorMap.has(key)) {
            errorMap.set(key, {
              pattern: `${toolUse.tool} failed: ${this.normalizeError(toolUse.error)}`,
              tool: toolUse.tool,
              error: this.normalizeError(toolUse.error),
              occurrences: [],
              frequency: 0,
              impact: this.assessImpact(toolUse.tool, toolUse.error),
              prevention: this.suggestPrevention(toolUse.tool, toolUse.error)
            });
          }

          const pattern = errorMap.get(key);
          pattern.frequency++;
          pattern.occurrences.push({
            sessionId: data.sessionId,
            timestamp: data.startTime,
            context: toolUse.parameters
          });
        }
      }

      // Find error sequences (Error A → Error B)
      for (let i = 0; i < (data.toolUses?.length || 0) - 1; i++) {
        const current = data.toolUses[i];
        const next = data.toolUses[i + 1];

        if (current.error && next.error) {
          const key = `sequence:${current.tool}→${next.tool}`;
          if (!errorMap.has(key)) {
            errorMap.set(key, {
              pattern: `Error sequence: ${current.tool} fails → ${next.tool} fails`,
              type: 'sequence',
              frequency: 0,
              occurrences: []
            });
          }
          errorMap.get(key).frequency++;
          errorMap.get(key).occurrences.push({
            sessionId: data.sessionId,
            timestamp: data.startTime
          });
        }
      }
    }

    // Convert to array and sort by frequency × impact
    return Array.from(errorMap.values())
      .map(p => ({
        ...p,
        priority: p.frequency * (p.impact || 1)
      }))
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * Detect success patterns
   */
  detectSuccessPatterns(transcripts) {
    const successMap = new Map();

    for (const transcript of transcripts) {
      const { data } = transcript;

      // Look for successful tool sequences
      const toolSequence = (data.toolUses || [])
        .filter(t => !t.error)
        .map(t => t.tool)
        .slice(0, 5); // First 5 tools

      if (toolSequence.length >= 2) {
        const key = toolSequence.join('→');

        if (!successMap.has(key)) {
          successMap.set(key, {
            pattern: `Successful sequence: ${key}`,
            sequence: toolSequence,
            frequency: 0,
            sessions: []
          });
        }

        successMap.get(key).frequency++;
        successMap.get(key).sessions.push({
          sessionId: data.sessionId,
          timestamp: data.startTime,
          duration: data.summary?.durationMs
        });
      }

      // Look for user praise patterns
      for (const msg of data.messages || []) {
        if (msg.type === 'user' && this.isPraise(msg.content)) {
          const key = 'user-praise';
          if (!successMap.has(key)) {
            successMap.set(key, {
              pattern: 'User provided positive feedback',
              frequency: 0,
              examples: []
            });
          }

          successMap.get(key).frequency++;
          successMap.get(key).examples.push({
            sessionId: data.sessionId,
            feedback: msg.content.substring(0, 100)
          });
        }
      }
    }

    return Array.from(successMap.values())
      .sort((a, b) => b.frequency - a.frequency);
  }

  /**
   * Detect compliance patterns (Project Vend robustness dimension)
   * Looks for times the agent agreed without questioning, bypassed checks,
   * or acted under pressure without verification.
   */
  detectCompliancePatterns(transcripts) {
    const complianceIssues = [];

    for (const transcript of transcripts) {
      const { data } = transcript;

      for (const msg of data.messages || []) {
        if (msg.type === 'assistant') {
          // Check for compliance without questioning
          if (this.isUnquestionedCompliance(msg.content)) {
            complianceIssues.push({
              type: 'unquestioned_compliance',
              sessionId: data.sessionId,
              timestamp: data.startTime,
              context: msg.content.substring(0, 300),
              severity: 'orange'
            });
          }

          // Check for bypassing safety checks
          if (this.isSafetyBypass(msg.content)) {
            complianceIssues.push({
              type: 'safety_bypass',
              sessionId: data.sessionId,
              timestamp: data.startTime,
              context: msg.content.substring(0, 300),
              severity: 'red'
            });
          }
        }

        // Check for urgency-driven requests from user
        if (msg.type === 'user' && this.isUrgencyPressure(msg.content)) {
          complianceIssues.push({
            type: 'urgency_pressure',
            sessionId: data.sessionId,
            timestamp: data.startTime,
            context: msg.content.substring(0, 300),
            severity: 'yellow'
          });
        }
      }
    }

    return complianceIssues;
  }

  /**
   * Detect decision patterns
   */
  detectDecisionPatterns(transcripts) {
    const decisions = [];

    for (const transcript of transcripts) {
      const { data } = transcript;

      // Look for decision keywords in messages
      for (const msg of data.messages || []) {
        if (msg.type === 'assistant' && this.isDecision(msg.content)) {
          decisions.push({
            sessionId: data.sessionId,
            timestamp: data.startTime,
            branch: data.gitBranch,
            decision: this.extractDecision(msg.content),
            context: msg.content.substring(0, 500)
          });
        }
      }
    }

    return decisions;
  }

  /**
   * Pre-flight check for tool execution
   */
  async preFlightCheck(tool, filePath) {
    const warnings = [];

    // Example: Check if file was read before Write/Edit
    if ((tool === 'Write' || tool === 'Edit') && filePath) {
      // This would need session context - placeholder for now
      warnings.push({
        type: 'read-before-write',
        message: `File ${filePath} should be read before ${tool}`,
        suggestion: `Read ${filePath} first to verify contents`
      });
    }

    return {
      tool,
      file: filePath,
      warnings,
      safe: warnings.length === 0
    };
  }

  /**
   * Format patterns as markdown
   */
  formatMarkdown(patterns) {
    let output = `# Pattern Analysis Report\n\n`;
    output += `**Generated**: ${new Date(patterns.generated).toLocaleString()}\n`;
    output += `**Period**: ${patterns.period.days ? `Last ${patterns.period.days} days` : `Since ${patterns.period.since}`}\n`;
    output += `**Transcripts**: ${patterns.period.transcripts}\n\n`;
    output += `---\n\n`;

    // Errors
    if (patterns.errors.length > 0) {
      output += `## 🔴 Error Patterns (${patterns.errors.length})\n\n`;
      for (const error of patterns.errors.slice(0, 10)) {
        output += `### ${error.pattern}\n`;
        output += `**Frequency**: ${error.frequency} occurrences\n`;
        output += `**Impact**: ${error.impact || 'unknown'}\n`;
        if (error.prevention) {
          output += `**Prevention**: ${error.prevention}\n`;
        }
        output += `\n`;
      }
    }

    // Successes
    if (patterns.successes.length > 0) {
      output += `## ✅ Success Patterns (${patterns.successes.length})\n\n`;
      for (const success of patterns.successes.slice(0, 10)) {
        output += `### ${success.pattern}\n`;
        output += `**Frequency**: ${success.frequency} times\n`;
        output += `\n`;
      }
    }

    // Decisions
    if (patterns.decisions.length > 0) {
      output += `## 📋 Recent Decisions (${patterns.decisions.length})\n\n`;
      for (const decision of patterns.decisions.slice(0, 5)) {
        output += `### ${decision.decision || 'Decision'}\n`;
        output += `**Date**: ${new Date(decision.timestamp).toLocaleDateString()}\n`;
        output += `**Session**: ${decision.sessionId.substring(0, 8)}...\n`;
        if (decision.branch) {
          output += `**Branch**: ${decision.branch}\n`;
        }
        output += `\n`;
      }
    }

    // Compliance (Project Vend robustness dimension)
    if (patterns.compliance && patterns.compliance.length > 0) {
      output += `## ⚠️ Compliance Patterns (${patterns.compliance.length})\n\n`;
      output += `> Flags times the agent may have been too agreeable or bypassed checks.\n\n`;

      const bySeverity = { red: [], orange: [], yellow: [] };
      for (const issue of patterns.compliance) {
        (bySeverity[issue.severity] || bySeverity.yellow).push(issue);
      }

      for (const [severity, issues] of Object.entries(bySeverity)) {
        if (issues.length === 0) continue;
        const icon = severity === 'red' ? '🔴' : severity === 'orange' ? '🟠' : '🟡';
        output += `### ${icon} ${severity.toUpperCase()} (${issues.length})\n\n`;
        for (const issue of issues.slice(0, 5)) {
          output += `- **${issue.type}** — Session ${issue.sessionId.substring(0, 8)}...\n`;
        }
        output += `\n`;
      }
    }

    return output;
  }

  /**
   * Update technical patterns file
   */
  async updateTechnicalPatterns(patterns, filePath) {
    let content = '';

    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      // File doesn't exist, create new
      content = '# Technical Patterns\n\n## Anti-Patterns\n\n## Best Practices\n\n';
    }

    // Append new patterns
    content += `\n\n## Pattern Update: ${new Date().toLocaleDateString()}\n\n`;
    content += this.formatMarkdown(patterns);

    await fs.writeFile(filePath, content, 'utf-8');
  }

  /**
   * Generate pre-flight check code
   */
  generatePreFlightChecks(patterns) {
    let code = `/**
 * Pre-flight checks generated from pattern analysis
 * Generated: ${new Date().toISOString()}
 */

export const preFlightChecks = {
`;

    // Generate checks for common errors
    for (const error of patterns.errors.slice(0, 5)) {
      if (error.tool === 'Write' || error.tool === 'Edit') {
        code += `
  ${error.tool.toLowerCase()}: (filePath, sessionContext) => {
    // Check: ${error.pattern}
    // Frequency: ${error.frequency} occurrences
    const warnings = [];

    if (!sessionContext.filesRead?.includes(filePath)) {
      warnings.push({
        type: 'read-before-write',
        message: 'File not read in this session',
        suggestion: \`Read(\${filePath}) before ${error.tool}\`
      });
    }

    return { warnings, safe: warnings.length === 0 };
  },
`;
      }
    }

    code += `};
`;

    return code;
  }

  // Helper methods

  normalizeError(error) {
    // Normalize error messages (remove file paths, line numbers, etc.)
    return error
      .replace(/\/[^\s]+/g, '<path>')
      .replace(/line \d+/g, 'line <N>')
      .replace(/\d+/g, '<N>');
  }

  assessImpact(tool, error) {
    // Simple heuristic for impact
    if (error.includes('not found') || error.includes('does not exist')) return 3;
    if (error.includes('permission') || error.includes('denied')) return 4;
    if (error.includes('syntax') || error.includes('parse')) return 2;
    return 1;
  }

  suggestPrevention(tool, error) {
    if (tool === 'Write' || tool === 'Edit') {
      if (error.includes('not found') || error.includes('not read')) {
        return 'Read file before Write/Edit';
      }
    }
    if (tool === 'Bash') {
      if (error.includes('not found') || error.includes('command')) {
        return 'Verify command exists before execution';
      }
    }
    return null;
  }

  isPraise(content) {
    const praiseWords = ['great', 'excellent', 'perfect', 'good job', 'well done', 'nice', 'awesome', 'thanks'];
    return praiseWords.some(word => content.toLowerCase().includes(word));
  }

  // Compliance detection helpers (Project Vend robustness dimension)

  isUnquestionedCompliance(content) {
    // Detect patterns where agent agrees without questioning premise
    const complianceMarkers = [
      'sure, i\'ll',
      'of course,',
      'right away',
      'i\'ll do that now',
      'proceeding with',
      'happy to help with that'
    ];
    const questionMarkers = ['why', 'are you sure', 'should we', 'have you considered', 'alternatively'];

    const lower = content.toLowerCase();
    const hasCompliance = complianceMarkers.some(m => lower.includes(m));
    const hasQuestion = questionMarkers.some(m => lower.includes(m));

    // Compliance without any questioning is a flag
    return hasCompliance && !hasQuestion;
  }

  isSafetyBypass(content) {
    const bypassMarkers = [
      '--no-verify',
      '--force',
      'skip test',
      'skip check',
      'force push',
      'without testing',
      '--no-edit',
      'disable validation'
    ];
    return bypassMarkers.some(m => content.toLowerCase().includes(m));
  }

  isUrgencyPressure(content) {
    const urgencyMarkers = [
      'asap',
      'right now',
      'immediately',
      'urgent',
      'before the demo',
      'need this shipped',
      'no time to',
      'skip the'
    ];
    return urgencyMarkers.some(m => content.toLowerCase().includes(m));
  }

  isDecision(content) {
    const decisionWords = ['decided', 'chose', 'selected', 'went with', 'decision:', 'alternative', 'option', 'vs'];
    return decisionWords.some(word => content.toLowerCase().includes(word));
  }

  extractDecision(content) {
    // Extract first sentence that looks like a decision
    const sentences = content.split(/[.!?]\s+/);
    for (const sentence of sentences) {
      if (this.isDecision(sentence)) {
        return sentence.substring(0, 200);
      }
    }
    return 'Decision made';
  }
}
