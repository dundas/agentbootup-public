/**
 * Memory Writer
 *
 * Formats extracted insights and writes them to memory files:
 * - memory/daily/YYYY-MM-DD.md - Daily session logs
 * - memory/MEMORY.md - Long-term learnings (curated)
 */

import fs from 'fs/promises';
import path from 'path';

export class MemoryWriter {
  constructor(options = {}) {
    this.basePath = options.basePath || process.cwd();
    this.memoryDir = path.join(this.basePath, 'memory');
    this.dailyDir = path.join(this.memoryDir, 'daily');
  }

  /**
   * Write insights to daily log
   */
  async writeDailyLog(insights) {
    const { sessionId, startTime, cwd, gitBranch, insights: data, metadata } = insights;

    // Ensure daily directory exists
    await fs.mkdir(this.dailyDir, { recursive: true });

    // Determine daily log file
    const date = new Date(startTime);
    const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
    const dailyLogPath = path.join(this.dailyDir, `${dateStr}.md`);

    // Format entry
    const entry = this.formatDailyEntry(insights);

    // Append to daily log
    try {
      const existing = await fs.readFile(dailyLogPath, 'utf-8').catch(() => '');

      // Check if this session already logged
      if (existing.includes(sessionId)) {
        console.log(`[MemoryWriter] Session ${sessionId} already in daily log`);
        return dailyLogPath;
      }

      // Append new entry
      const updated = existing
        ? `${existing}\n\n${entry}`
        : this.formatDailyHeader(dateStr) + '\n\n' + entry;

      await fs.writeFile(dailyLogPath, updated, 'utf-8');
      console.log(`[MemoryWriter] Wrote to ${dailyLogPath}`);

      return dailyLogPath;
    } catch (err) {
      console.error('[MemoryWriter] Failed to write daily log:', err);
      throw err;
    }
  }

  /**
   * Format daily log header
   */
  formatDailyHeader(dateStr) {
    return `# Daily Log: ${dateStr}

> Autonomous session analysis and learnings`;
  }

  /**
   * Format daily entry
   */
  formatDailyEntry(insights) {
    const { sessionId, startTime, cwd, gitBranch, insights: data, metadata } = insights;

    const time = new Date(startTime).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });

    let entry = `## Session ${sessionId.substring(0, 8)} (${time})

**Summary:** ${data.summary}
**Duration:** ${metadata.durationFormatted}
**Location:** \`${cwd}\`
**Branch:** \`${gitBranch || 'unknown'}\`
**Activity:** ${metadata.messageCount} messages, ${metadata.filesModified} files modified`;

    if (metadata.errors > 0) {
      entry += `, ${metadata.errors} errors`;
    }

    // Technical learnings
    if (data.technicalLearnings.length > 0) {
      entry += '\n\n### Technical Learnings\n';
      data.technicalLearnings.forEach(learning => {
        entry += `- ${learning}\n`;
      });
    }

    // Skills developed
    if (data.skillsDeveloped.length > 0) {
      entry += '\n\n### Skills Developed\n';
      data.skillsDeveloped.forEach(skill => {
        entry += `- ${skill}\n`;
      });
    }

    // Mistakes and corrections
    if (data.mistakesAndCorrections.length > 0) {
      entry += '\n\n### Mistakes & Corrections\n';
      data.mistakesAndCorrections.forEach(item => {
        entry += `- **Mistake:** ${item.mistake}\n`;
        entry += `  - **Correction:** ${item.correction}\n`;
        entry += `  - **Lesson:** ${item.lesson}\n`;
      });
    }

    // Strategic decisions
    if (data.strategicDecisions.length > 0) {
      entry += '\n\n### Strategic Decisions\n';
      data.strategicDecisions.forEach(item => {
        entry += `- **Decision:** ${item.decision}\n`;
        entry += `  - **Rationale:** ${item.rationale}\n`;
        if (item.alternatives) {
          entry += `  - **Alternatives:** ${item.alternatives}\n`;
        }
      });
    }

    // Patterns
    if (data.patterns.length > 0) {
      entry += '\n\n### Patterns\n';
      data.patterns.forEach(pattern => {
        entry += `- ${pattern}\n`;
      });
    }

    return entry;
  }

  /**
   * Update MEMORY.md with significant learnings
   *
   * Strategy:
   * 1. Read existing MEMORY.md
   * 2. Find "Critical Learnings" section (or create it)
   * 3. Deduplicate against existing content
   * 4. Append new learnings under dated subsection
   * 5. Trim if over 200 lines
   */
  async updateMemoryMd(insights) {
    const { insights: data, sessionId } = insights;

    // Collect significant learnings
    const significantLearnings = [
      ...data.technicalLearnings.filter(l => this.isSignificant(l)),
      ...data.patterns.filter(p => this.isSignificant(p))
    ];

    const significantMistakes = data.mistakesAndCorrections.filter(m =>
      this.isSignificant(m.lesson || m.mistake)
    );

    if (significantLearnings.length === 0 && significantMistakes.length === 0) {
      console.log('[MemoryWriter] No significant learnings for MEMORY.md');
      return null;
    }

    const memoryPath = path.join(this.memoryDir, 'MEMORY.md');

    try {
      let existing = await fs.readFile(memoryPath, 'utf-8').catch(() => null);

      if (!existing) {
        console.log('[MemoryWriter] MEMORY.md not found, creating new one');
        existing = this.createDefaultMemoryMd();
      }

      // Deduplicate against existing content
      const newLearnings = significantLearnings.filter(l =>
        !this.isDuplicate(l, existing)
      );

      const newMistakes = significantMistakes.filter(m =>
        !this.isDuplicate(m.lesson || m.mistake, existing)
      );

      if (newLearnings.length === 0 && newMistakes.length === 0) {
        console.log('[MemoryWriter] All learnings already in MEMORY.md');
        return null;
      }

      // Build the new content to insert
      let insertContent = '';

      if (newLearnings.length > 0) {
        insertContent += newLearnings.map(l => `- ${l}`).join('\n') + '\n';
      }

      if (newMistakes.length > 0) {
        insertContent += newMistakes.map(m =>
          `- **${m.mistake}** → ${m.correction} (${m.lesson})`
        ).join('\n') + '\n';
      }

      // Insert under "## Critical Learnings" section
      const updated = this.insertIntoSection(
        existing,
        'Critical Learnings',
        insertContent
      );

      // Trim if over 200 lines
      const lines = updated.split('\n');
      const finalContent = lines.length > 200
        ? this.trimMemoryMd(updated)
        : updated;

      await fs.writeFile(memoryPath, finalContent, 'utf-8');
      console.log(`[MemoryWriter] Updated MEMORY.md with ${newLearnings.length + newMistakes.length} new learnings`);

      return memoryPath;
    } catch (err) {
      console.error('[MemoryWriter] Failed to update MEMORY.md:', err);
      return null;
    }
  }

  /**
   * Insert content into a specific section of MEMORY.md
   */
  insertIntoSection(content, sectionName, newContent) {
    const sectionHeader = `## ${sectionName}`;
    const sectionIndex = content.indexOf(sectionHeader);

    if (sectionIndex === -1) {
      // Section doesn't exist - add before "## Standing Orders" or at end
      const standingOrdersIndex = content.indexOf('## Standing Orders');
      const insertPoint = standingOrdersIndex !== -1
        ? standingOrdersIndex
        : content.length;

      const dateStr = new Date().toISOString().split('T')[0];
      const sectionBlock = `${sectionHeader}\n\n### Auto-extracted (${dateStr})\n${newContent}\n`;

      return content.slice(0, insertPoint) + sectionBlock + '\n' + content.slice(insertPoint);
    }

    // Find end of section (next ## heading or end of file)
    const afterSection = content.slice(sectionIndex + sectionHeader.length);
    const nextSectionMatch = afterSection.match(/\n## [^#]/);
    const sectionEndIndex = nextSectionMatch
      ? sectionIndex + sectionHeader.length + nextSectionMatch.index
      : content.length;

    // Append dated subsection at end of section
    const sectionContent = content.slice(sectionIndex, sectionEndIndex);
    const dateStr = new Date().toISOString().split('T')[0];
    const appendBlock = `\n### Auto-extracted (${dateStr})\n${newContent}`;
    const updatedSection = sectionContent.trimEnd() + '\n' + appendBlock + '\n';

    return content.slice(0, sectionIndex) + updatedSection + '\n' + content.slice(sectionEndIndex);
  }

  /**
   * Check if a learning is a duplicate of existing content
   */
  isDuplicate(learning, existingContent) {
    const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    const normalizedLearning = normalize(learning);
    const normalizedExisting = normalize(existingContent);

    // Exact substring match
    if (normalizedExisting.includes(normalizedLearning)) {
      return true;
    }

    // Significant word overlap (>70% of meaningful words match)
    const learningWords = new Set(normalizedLearning.split(/\s+/).filter(w => w.length > 3));
    const existingWords = new Set(normalizedExisting.split(/\s+/));

    if (learningWords.size === 0) return false;

    let matchCount = 0;
    for (const word of learningWords) {
      if (existingWords.has(word)) matchCount++;
    }

    return (matchCount / learningWords.size) > 0.7;
  }

  /**
   * Trim MEMORY.md to stay under 200 lines
   * Removes oldest auto-extracted sections first.
   * Only removes auto-extracted blocks, never hand-written content.
   */
  trimMemoryMd(content) {
    const lines = content.split('\n');

    // Find auto-extracted subsections (oldest first)
    // Each block runs from "### Auto-extracted (" to the next heading (## or ###)
    const autoSections = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trimStart().match(/^### Auto-extracted \(/)) {
        let end = i + 1;
        // Stop at next heading of any level (## or ###) to avoid consuming hand-written content
        while (end < lines.length && !lines[end].trimStart().match(/^#{2,3}\s/)) {
          end++;
        }
        autoSections.push({ start: i, end, length: end - i });
      }
    }

    // Remove oldest auto-extracted sections until under 200 lines
    let result = [...lines];
    let removed = 0;
    for (const section of autoSections) {
      if (result.length <= 200) break;
      const adjustedStart = section.start - removed;
      const adjustedLength = section.length;
      result.splice(adjustedStart, adjustedLength);
      removed += adjustedLength;
    }

    return result.join('\n');
  }

  /**
   * Create a default MEMORY.md if one doesn't exist
   */
  createDefaultMemoryMd() {
    const dateStr = new Date().toISOString().split('T')[0];
    return `# Autonomous Memory System

## Core Identity

**Name**: [Project Name]
**Role**: Self-Improving Development Assistant
**Purpose**: Learn from every interaction and build permanent knowledge

## Critical Learnings

## Skills Acquired (0)

## Standing Orders

1. Check memory at session start
2. Learn continuously
3. Build skills permanently
4. Fix issues immediately

---

**Last Updated**: ${dateStr}
**Status**: Autonomous mode active
`;
  }

  /**
   * Determine if a learning is significant enough for MEMORY.md
   */
  isSignificant(learning) {
    if (!learning || typeof learning !== 'string') return false;

    const keywords = [
      'never', 'always', 'critical', 'important', 'pattern', 'anti-pattern',
      'security', 'must', 'required', 'breaking', 'gotcha', 'caveat',
      'workaround', 'performance', 'bug', 'fix'
    ];
    const hasKeyword = keywords.some(kw => learning.toLowerCase().includes(kw));
    const isSubstantial = learning.length > 50;

    return hasKeyword || isSubstantial;
  }

  /**
   * Get summary of what was written
   */
  getSummary(dailyLogPath, memoryPath) {
    return {
      dailyLog: dailyLogPath,
      memoryUpdated: !!memoryPath,
      timestamp: new Date().toISOString()
    };
  }
}
