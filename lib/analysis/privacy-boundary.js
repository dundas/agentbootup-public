import { MechLLMsClient } from './mech-llms-client.js';
import { ANALYSIS_POLICY_STATE, sanitizeAnalysisText } from './privacy-policy.js';

export const ANALYSIS_PRIVACY_LIMITS = Object.freeze({
  maxMessages: 10,
  maxMessageCharacters: 500,
  maxTotalCharacters: 4_000,
  maxRequestBytes: 32 * 1024,
});

const verifiedProjections = new WeakSet();
const allowedCli = new Set(['claude', 'codex', 'cursor', 'gemini', 'unknown']);

function boundedInteger(value, maximum) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : 0;
}

function safeCli(value) {
  return allowedCli.has(value) ? value : 'unknown';
}

function blocked(state, code) {
  return Object.freeze({ state, code });
}

function prepareMessage(content, policy) {
  if (typeof content !== 'string') return blocked('blocked_redaction', 'analysis_input_unprovable');
  // Inspect the complete local value first. Truncating before the policy check
  // could cut through a sensitive value and let a prefix reach the sender.
  const sanitized = sanitizeAnalysisText(content, policy);
  if (sanitized.state !== ANALYSIS_POLICY_STATE.usable) {
    return blocked('blocked_redaction', sanitized.code);
  }
  return { ...sanitized, cleanContent: sanitized.cleanContent.slice(0, ANALYSIS_PRIVACY_LIMITS.maxMessageCharacters) };
}

/**
 * Create a fresh, allowlisted and frozen projection. Raw transcript metadata,
 * paths, tool payloads, IDs, and errors are intentionally absent.
 */
export function createVerifiedAnalysisProjection(transcriptData, policy) {
  if (!transcriptData || typeof transcriptData !== 'object') {
    return blocked('blocked_redaction', 'analysis_input_unprovable');
  }
  // A message-less transcript must not turn an unavailable policy into an
  // implicit allow. Probe the opaque handle before any projection is minted.
  const policyProbe = sanitizeAnalysisText('', policy);
  if (policyProbe.state !== ANALYSIS_POLICY_STATE.usable) {
    return blocked('blocked_redaction', policyProbe.code);
  }
  const messages = Array.isArray(transcriptData.messages) ? transcriptData.messages : [];
  const selected = messages.filter((message) => message?.type === 'user').slice(0, ANALYSIS_PRIVACY_LIMITS.maxMessages);
  const cleanMessages = [];
  let totalCharacters = 0;
  for (const message of selected) {
    const sanitized = prepareMessage(message.content, policy);
    if (sanitized.state !== ANALYSIS_POLICY_STATE.usable) return sanitized;
    const remaining = ANALYSIS_PRIVACY_LIMITS.maxTotalCharacters - totalCharacters;
    if (remaining <= 0) break;
    const text = sanitized.cleanContent.slice(0, remaining);
    totalCharacters += text.length;
    cleanMessages.push(text);
  }
  const summary = transcriptData.summary && typeof transcriptData.summary === 'object' ? transcriptData.summary : {};
  const projection = Object.freeze({
    cli: safeCli(transcriptData.cli),
    messageCount: boundedInteger(summary.messageCount, 1_000_000),
    durationMs: boundedInteger(summary.durationMs, 7 * 24 * 60 * 60 * 1000),
    messages: Object.freeze(cleanMessages),
    toolCategory: Array.isArray(transcriptData.toolUses) && transcriptData.toolUses.length > 0 ? 'present' : 'none',
    errorCategory: Array.isArray(transcriptData.errors) && transcriptData.errors.length > 0 ? 'present' : 'none',
  });
  verifiedProjections.add(projection);
  return projection;
}

function verifyProjection(projection, policy) {
  if (!verifiedProjections.has(projection) || !Object.isFrozen(projection)
      || !Array.isArray(projection.messages) || !Object.isFrozen(projection.messages)
      || !allowedCli.has(projection.cli) || !['present', 'none'].includes(projection.toolCategory)
      || !['present', 'none'].includes(projection.errorCategory)) {
    return null;
  }
  let totalCharacters = 0;
  for (const message of projection.messages) {
    if (typeof message !== 'string' || message.length > ANALYSIS_PRIVACY_LIMITS.maxMessageCharacters) return null;
    const sanitized = sanitizeAnalysisText(message, policy);
    if (sanitized.state !== ANALYSIS_POLICY_STATE.usable || sanitized.cleanContent !== message) return null;
    totalCharacters += message.length;
    if (totalCharacters > ANALYSIS_PRIVACY_LIMITS.maxTotalCharacters) return null;
  }
  return projection;
}

function buildPrompt(projection) {
  return [
    'Extract concise technical learnings from this redacted coding-session projection.',
    `CLI category: ${projection.cli}`,
    `Message count: ${projection.messageCount}`,
    `Duration milliseconds: ${projection.durationMs}`,
    `Tool activity: ${projection.toolCategory}`,
    `Error activity: ${projection.errorCategory}`,
    'Redacted user messages:',
    ...projection.messages.map((message) => `- ${message}`),
    'Return JSON only with technicalLearnings, skillsDeveloped, mistakesAndCorrections, strategicDecisions, patterns, and summary.',
  ].join('\n');
}

/**
 * The sole analysis sender. It accepts only a module-verified projection and
 * performs the final whole-body verification before the generic client sends.
 */
export async function sendVerifiedAnalysisProjection(projection, policy, config) {
  const verified = verifyProjection(projection, policy);
  if (!verified) return blocked('blocked_redaction', 'analysis_projection_unverified');
  const prompt = buildPrompt(verified);
  const request = { model: config.model || 'claude-sonnet-4-5', prompt, max_tokens: 2_000, temperature: 0.3 };
  const serialized = JSON.stringify(request);
  if (Buffer.byteLength(serialized, 'utf8') > ANALYSIS_PRIVACY_LIMITS.maxRequestBytes) {
    return blocked('blocked_redaction', 'analysis_request_too_large');
  }
  const client = new MechLLMsClient(config);
  return client.complete(request);
}
