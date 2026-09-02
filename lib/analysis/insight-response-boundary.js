import { createHash } from 'node:crypto';
import { ANALYSIS_POLICY_STATE, sanitizeAnalysisText } from './privacy-policy.js';

export const INSIGHT_RESPONSE_LIMITS = Object.freeze({
  maxItemsPerList: 20,
  maxTextCharacters: 500,
  maxTotalCharacters: 8_000,
  maxResponseBytes: 64 * 1024,
});

const verifiedEnvelopes = new WeakSet();
const allowedCli = new Set(['claude', 'codex', 'cursor', 'gemini', 'unknown']);
const arrayFields = ['technicalLearnings', 'skillsDeveloped', 'patterns'];
const objectFields = {
  mistakesAndCorrections: ['mistake', 'correction', 'lesson'],
  strategicDecisions: ['decision', 'rationale', 'alternatives'],
};
const allowedInsightKeys = new Set([...arrayFields, ...Object.keys(objectFields), 'summary']);

function blocked(code) {
  return Object.freeze({ state: 'blocked_response', code });
}

function parseCompletion(completion) {
  if (typeof completion !== 'string' || Buffer.byteLength(completion, 'utf8') > INSIGHT_RESPONSE_LIMITS.maxResponseBytes) return null;
  const match = completion.match(/^\s*```json\s*\n([\s\S]*?)\n```\s*$/);
  try { return JSON.parse(match ? match[1] : completion); } catch { return null; }
}

function cleanText(value, policy, budget) {
  if (typeof value !== 'string' || value.length > INSIGHT_RESPONSE_LIMITS.maxTextCharacters) return null;
  const sanitized = sanitizeAnalysisText(value, policy);
  if (sanitized.state !== ANALYSIS_POLICY_STATE.usable || sanitized.cleanContent !== value || value.length > budget.remaining) return null;
  budget.remaining -= value.length;
  return value;
}

function exactObject(value, keys, policy, budget) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) return null;
  const clean = {};
  for (const key of keys) {
    const text = cleanText(value[key], policy, budget);
    if (text === null) return null;
    clean[key] = text;
  }
  return Object.freeze(clean);
}

/** Parse, schema-check, and re-verify an LLM response before any memory write. */
export function createVerifiedInsightEnvelope(completion, context, policy) {
  const parsed = parseCompletion(completion);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).length !== allowedInsightKeys.size
    || ![...allowedInsightKeys].every((key) => Object.hasOwn(parsed, key))) return blocked('analysis_response_invalid');
  const budget = { remaining: INSIGHT_RESPONSE_LIMITS.maxTotalCharacters };
  const insights = {};
  for (const field of arrayFields) {
    if (!Array.isArray(parsed[field]) || parsed[field].length > INSIGHT_RESPONSE_LIMITS.maxItemsPerList) return blocked('analysis_response_invalid');
    const values = parsed[field].map((value) => cleanText(value, policy, budget));
    if (values.some((value) => value === null)) return blocked('analysis_response_unprovable');
    insights[field] = Object.freeze(values);
  }
  for (const [field, keys] of Object.entries(objectFields)) {
    if (!Array.isArray(parsed[field]) || parsed[field].length > INSIGHT_RESPONSE_LIMITS.maxItemsPerList) return blocked('analysis_response_invalid');
    const values = parsed[field].map((value) => exactObject(value, keys, policy, budget));
    if (values.some((value) => value === null)) return blocked('analysis_response_unprovable');
    insights[field] = Object.freeze(values);
  }
  const summary = cleanText(parsed.summary, policy, budget);
  if (summary === null) return blocked('analysis_response_unprovable');
  insights.summary = summary;
  const sessionId = typeof context?.sessionId === 'string' ? context.sessionId : '';
  if (!sessionId) return blocked('analysis_context_unprovable');
  const envelope = Object.freeze({
    analysisId: createHash('sha256').update(sessionId).digest('hex').slice(0, 16),
    startTime: Number.isSafeInteger(context?.startTime) && context.startTime >= 0 ? context.startTime : 0,
    metadata: Object.freeze({
      cli: allowedCli.has(context?.cli) ? context.cli : 'unknown',
      durationMs: Number.isSafeInteger(context?.durationMs) && context.durationMs >= 0 ? context.durationMs : 0,
      messageCount: Number.isSafeInteger(context?.messageCount) && context.messageCount >= 0 ? context.messageCount : 0,
      filesModified: Number.isSafeInteger(context?.filesModified) && context.filesModified >= 0 ? context.filesModified : 0,
      errors: Number.isSafeInteger(context?.errors) && context.errors >= 0 ? context.errors : 0,
    }),
    insights: Object.freeze(insights),
  });
  verifiedEnvelopes.add(envelope);
  return envelope;
}

export function isVerifiedInsightEnvelope(envelope) {
  return verifiedEnvelopes.has(envelope) && Object.isFrozen(envelope);
}
