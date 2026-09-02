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

import { createVerifiedAnalysisProjection, sendVerifiedAnalysisProjection } from './privacy-boundary.js';
import { createVerifiedInsightEnvelope } from './insight-response-boundary.js';
import { createAnalysisPrivacyPolicy } from './privacy-policy.js';

function analysisStartTime(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export class InsightExtractor {
  constructor(config, options = {}) {
    this.config = config;
    this.policy = options.policy || createAnalysisPrivacyPolicy(options.projectRoots || []);
  }

  /**
   * Extract insights from a parsed transcript
   */
  async extractInsights(transcriptData, context = {}) {
    const sessionId = typeof context.sessionId === 'string' ? context.sessionId : transcriptData?.sessionId;
    if (!sessionId) return Object.freeze({ state: 'blocked_redaction', code: 'analysis_context_unprovable' });
    const projection = createVerifiedAnalysisProjection(transcriptData, this.policy);
    if (projection?.state) return projection;
    const response = await sendVerifiedAnalysisProjection(projection, this.policy, this.config);
    if (response?.state) return response;
    return createVerifiedInsightEnvelope(response?.completion, {
      sessionId,
      startTime: analysisStartTime(transcriptData?.startTime),
      cli: transcriptData?.cli,
      durationMs: transcriptData?.summary?.durationMs,
      messageCount: transcriptData?.summary?.messageCount,
      filesModified: Array.isArray(transcriptData?.filesModified) ? transcriptData.filesModified.length : 0,
      errors: Array.isArray(transcriptData?.errors) ? transcriptData.errors.length : 0,
    }, this.policy);
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
