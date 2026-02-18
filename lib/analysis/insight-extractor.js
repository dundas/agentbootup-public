/**
 * Insight Extractor
 *
 * Uses LLM to analyze session transcripts and extract:
 * - Technical learnings
 * - Skills developed
 * - Mistakes and corrections
 * - Strategic decisions
 * - Patterns worth remembering
 */

export class InsightExtractor {
  constructor(llmClient) {
    this.llmClient = llmClient; // Mech LLMs API client
  }

  /**
   * Extract insights from a parsed transcript
   */
  async extractInsights(transcriptData) {
    const {
      sessionId,
      startTime,
      cwd,
      gitBranch,
      messages,
      filesModified,
      errors,
      summary
    } = transcriptData;

    // Build context for LLM
    const context = this.buildContext(transcriptData);

    // Call LLM to extract insights
    const prompt = this.buildExtractionPrompt(context);

    const response = await this.llmClient.complete({
      model: 'claude-sonnet-4-5',
      prompt,
      max_tokens: 2000,
      temperature: 0.3 // Lower temperature for more focused extraction
    });

    // Parse LLM response into structured insights
    const insights = this.parseInsights(response.completion);

    return {
      sessionId,
      startTime,
      cwd,
      gitBranch,
      insights,
      metadata: {
        durationFormatted: summary.durationFormatted,
        messageCount: summary.messageCount,
        filesModified: filesModified.length,
        errors: errors.length
      }
    };
  }

  /**
   * Build context summary for LLM
   */
  buildContext(data) {
    const { messages, filesModified, errors, summary } = data;

    // Sample key messages (first 5 user messages, significant assistant responses)
    const userMessages = messages.filter(m => m.type === 'user').slice(0, 10);
    const conversation = userMessages.map(m => {
      return `User: ${m.content.substring(0, 500)}`;
    }).join('\n\n');

    // Files modified summary
    const filesSummary = filesModified.length > 0
      ? `Files modified: ${filesModified.map(f => f.path).join(', ')}`
      : 'No files modified';

    // Errors summary
    const errorsSummary = errors.length > 0
      ? `Errors encountered: ${errors.length} errors`
      : 'No errors';

    return {
      conversation,
      filesSummary,
      errorsSummary,
      duration: summary.durationFormatted,
      messageCount: summary.messageCount,
      cwd: data.cwd,
      branch: data.gitBranch
    };
  }

  /**
   * Build LLM extraction prompt
   */
  buildExtractionPrompt(context) {
    return `You are analyzing a coding session transcript to extract key learnings and insights for future reference.

## Session Context

**Duration:** ${context.duration}
**Messages:** ${context.messageCount}
**Working Directory:** ${context.cwd}
**Branch:** ${context.branch}
**${context.filesSummary}**
**${context.errorsSummary}**

## Conversation Summary

${context.conversation}

## Your Task

Extract the following insights from this session:

1. **Technical Learnings** - New APIs, patterns, or techniques discovered
2. **Skills Developed** - New capabilities or improvements to existing skills
3. **Mistakes & Corrections** - Errors made and how they were fixed
4. **Strategic Decisions** - Important choices made and their rationale
5. **Patterns** - Recurring issues or successful approaches worth remembering

Format your response as structured JSON:

\`\`\`json
{
  "technicalLearnings": ["Learning 1", "Learning 2"],
  "skillsDeveloped": ["Skill 1", "Skill 2"],
  "mistakesAndCorrections": [
    {"mistake": "X", "correction": "Y", "lesson": "Z"}
  ],
  "strategicDecisions": [
    {"decision": "X", "rationale": "Y", "alternatives": "Z"}
  ],
  "patterns": ["Pattern 1", "Pattern 2"],
  "summary": "One-sentence summary of what was accomplished"
}
\`\`\`

**Important:**
- Only include significant insights, not trivial details
- Be specific and actionable
- If no insights in a category, use empty array
- Keep each insight concise (1-2 sentences max)`;
  }

  /**
   * Parse LLM response into structured insights
   */
  parseInsights(completion) {
    try {
      // Extract JSON from markdown code block if present
      const jsonMatch = completion.match(/```json\n([\s\S]*?)\n```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : completion;

      const parsed = JSON.parse(jsonStr);

      // Validate structure
      return {
        technicalLearnings: parsed.technicalLearnings || [],
        skillsDeveloped: parsed.skillsDeveloped || [],
        mistakesAndCorrections: parsed.mistakesAndCorrections || [],
        strategicDecisions: parsed.strategicDecisions || [],
        patterns: parsed.patterns || [],
        summary: parsed.summary || 'Session analyzed'
      };
    } catch (err) {
      console.error('[InsightExtractor] Failed to parse LLM response:', err);

      // Fallback: basic extraction
      return {
        technicalLearnings: [],
        skillsDeveloped: [],
        mistakesAndCorrections: [],
        strategicDecisions: [],
        patterns: [],
        summary: 'Session completed (parsing failed)'
      };
    }
  }

  /**
   * Determine if session is significant enough to analyze
   */
  isSignificant(transcriptData) {
    const { summary, filesModified, errors } = transcriptData;

    // Analyze if:
    // - More than 10 messages
    // - Files were modified
    // - Errors were encountered (learning opportunity)
    // - Session lasted more than 5 minutes

    return (
      summary.messageCount > 10 ||
      filesModified.length > 0 ||
      errors.length > 0 ||
      summary.durationMs > 5 * 60 * 1000
    );
  }
}
