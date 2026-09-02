import { createHash } from 'crypto';
import { stableJson } from './stable-json.js';

export const MECH_RUN_SCHEMA_VERSION = 1;
export const MECH_RUN_NORMALIZATION_VERSION = 'mech-run.v1';

// This schema intentionally differs from the transcript-query skill adapters:
// adapters return session summaries for search, while mech-run.v1 stores durable
// per-event JSONL with stable IDs and raw provenance for cache/recall pipelines.

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function buildEventId({ provider, sessionId, rawEntry, index, type, role, timestamp, content }) {
  return sha256([
    MECH_RUN_NORMALIZATION_VERSION,
    provider,
    sessionId,
    rawEntry.machineId || '',
    rawEntry.rawCachePath || '',
    rawEntry.contentHash || '',
    String(index),
    type,
    role || '',
    timestamp || '',
    content,
  ].join('\0')).slice(0, 32);
}

export function stringifyNormalizedEvents(events) {
  return events.map((event) => JSON.stringify(stableJson(event))).join('\n') + (events.length ? '\n' : '');
}

function normalizeTimestamp(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === 'string') return item;
      if (typeof item?.text === 'string') return item.text;
      if (typeof item?.content === 'string') return item.content;
      return '';
    }).filter(Boolean).join('\n');
  }
  if (typeof content.text === 'string') return content.text;
  return JSON.stringify(content);
}

function baseEvent({ provider, sessionId, rawEntry, index, type, timestamp, role = null, content = '', rawType = '' }) {
  const eventId = buildEventId({ provider, sessionId, rawEntry, index, type, role, timestamp, content });
  return {
    schemaVersion: MECH_RUN_SCHEMA_VERSION,
    normalizationVersion: MECH_RUN_NORMALIZATION_VERSION,
    eventId,
    sessionId,
    provider,
    timestamp,
    type,
    role,
    content,
    provenance: {
      machineId: rawEntry.machineId,
      rawCachePath: rawEntry.rawCachePath,
      sourcePath: rawEntry.sourcePath,
      sourceRelativePath: rawEntry.sourceRelativePath,
      contentHash: rawEntry.contentHash,
      rawType,
      ordinal: index,
    },
  };
}

function parseJsonLines(text) {
  const events = [];
  const errors = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      events.push({ value: JSON.parse(line), index });
    } catch (err) {
      errors.push({ index, error: err.message });
    }
  });
  return { events, errors };
}

function isMechRunRecord(value) {
  return Boolean(value && value.normalizationVersion === MECH_RUN_NORMALIZATION_VERSION && value.eventId);
}

function hasToolUseContent(content) {
  return Array.isArray(content) && content.some((item) => item?.input != null || item?.type === 'tool_use');
}

function isNativeJsonlRecord(value, provider) {
  if (!value || typeof value !== 'object') return false;
  if (provider === 'codex') {
    const payload = value.payload || {};
    return Boolean(
      (value.type === 'event_msg' && payload.type === 'user_message' && payload.message)
      || (value.type === 'response_item' && payload.type === 'message' && contentToText(payload.content))
      || (value.type === 'response_item' && payload.type === 'function_call')
    );
  }
  if (hasToolUseContent(value.message?.content ?? value.content)) return true;
  const messageContent = contentToText(value.message?.content ?? value.content ?? value.text);
  if (messageContent) return true;
  return Boolean(value.type === 'tool_use' || value.tool || value.toolName);
}

function normalizeExistingMechRun(records, context) {
  const firstNormalizable = records.find(({ value }) => isMechRunRecord(value) || isNativeJsonlRecord(value, context.provider));
  const mechRunLike = isMechRunRecord(firstNormalizable?.value);
  if (!mechRunLike) return null;

  const mismatches = [];
  const events = records
    .filter(({ value, index }) => {
      const isMechRun = isMechRunRecord(value);
      if (!isMechRun) mismatches.push({ index, error: 'mech_run_record_mismatch' });
      return isMechRun;
    })
    .map(({ value, index }) => {
      const provider = value.provider || context.provider;
      const sessionId = context.sessionId || value.sessionId;
      const type = value.type || 'message';
      const role = value.role || null;
      const timestamp = value.timestamp || null;
      const content = value.content || '';
      const provenance = {
        ...(value.provenance || {}),
        machineId: context.rawEntry.machineId,
        rawCachePath: context.rawEntry.rawCachePath,
        sourcePath: context.rawEntry.sourcePath,
        sourceRelativePath: context.rawEntry.sourceRelativePath,
        contentHash: context.rawEntry.contentHash,
        ordinal: value.provenance?.ordinal ?? index,
      };
      return {
        ...value,
        schemaVersion: value.schemaVersion || MECH_RUN_SCHEMA_VERSION,
        normalizationVersion: MECH_RUN_NORMALIZATION_VERSION,
        eventId: buildEventId({ provider, sessionId, rawEntry: context.rawEntry, index: provenance.ordinal, type, role, timestamp, content }),
        provider,
        sessionId,
        provenance,
      };
    });
  return { events, errors: mismatches.map((mismatch) => ({ type: 'normalization_failed', ...mismatch })) };
}

function normalizeClaude(records, context) {
  const out = [];
  let ordinal = 0;
  for (const { value, index } of records) {
    const role = value.type === 'user' ? 'user' : value.type === 'assistant' ? 'assistant' : value.message?.role || null;
    const rawContent = value.message?.content ?? value.content ?? value.text;
    const content = contentToText(rawContent);
    if (content) {
      out.push(baseEvent({
        ...context,
        index: ordinal++,
        type: 'message',
        role,
        content,
        timestamp: normalizeTimestamp(value.timestamp),
        rawType: value.type || '',
      }));
    }
    if (Array.isArray(rawContent)) {
      for (const item of rawContent) {
        if (item?.input == null) continue;
        out.push(baseEvent({
          ...context,
          index: ordinal++,
          type: 'tool',
          content: typeof item.input === 'string' ? item.input : JSON.stringify(item.input),
          timestamp: normalizeTimestamp(value.timestamp),
          rawType: item.type || value.type || 'tool',
        }));
      }
    }
    if (content) continue;
    if (value.type === 'tool_use' || value.tool || value.toolName) {
      out.push(baseEvent({
        ...context,
        index: ordinal++,
        type: 'tool',
        content: JSON.stringify(value.parameters || value.input || value.result || {}),
        timestamp: normalizeTimestamp(value.timestamp),
        rawType: value.type || value.toolName || 'tool',
      }));
    }
  }
  return out;
}

function normalizeCodex(records, context) {
  const out = [];
  for (const { value, index } of records) {
    const payload = value.payload || {};
    if (value.type === 'event_msg' && payload.type === 'user_message' && payload.message) {
      out.push(baseEvent({ ...context, index, type: 'message', role: 'user', content: payload.message, timestamp: normalizeTimestamp(value.timestamp), rawType: value.type }));
    } else if (value.type === 'response_item' && payload.type === 'message') {
      const content = contentToText(payload.content);
      if (content) out.push(baseEvent({ ...context, index, type: 'message', role: payload.role || 'assistant', content, timestamp: normalizeTimestamp(value.timestamp), rawType: value.type }));
    } else if (value.type === 'response_item' && payload.type === 'function_call') {
      out.push(baseEvent({ ...context, index, type: 'tool', content: JSON.stringify({ name: payload.name, arguments: payload.arguments || {} }), timestamp: normalizeTimestamp(value.timestamp), rawType: payload.type }));
    }
  }
  return out;
}

function normalizeGeminiObject(session, context) {
  const messages = Array.isArray(session.messages) ? session.messages : Array.isArray(session.events) ? session.events : [];
  const out = [];
  let ordinal = 0;
  messages.forEach((msg, index) => {
    const role = msg.type === 'gemini' ? 'assistant' : msg.role || msg.type || null;
    const content = contentToText(msg.content ?? msg.text ?? msg.message);
    if (content) {
      out.push(baseEvent({
        ...context,
        index: ordinal++,
        type: 'message',
        role,
        content,
        timestamp: normalizeTimestamp(msg.timestamp ?? session.startTime),
        rawType: msg.type || '',
      }));
    }
    let toolIndex = 0;
    for (const toolCall of Array.isArray(msg.toolCalls) ? msg.toolCalls : []) {
      out.push(baseEvent({
        ...context,
        index: ordinal++,
        type: 'tool',
        content: JSON.stringify(toolCall),
        timestamp: normalizeTimestamp(toolCall.timestamp || msg.timestamp),
        rawType: `toolCall:${index}:${toolIndex++}`,
      }));
    }
  });
  return out;
}

function normalizeCursorText(text, context) {
  const out = [];
  const lines = text.split(/\r?\n/);
  let role = null;
  let buffer = [];
  const flush = (index) => {
    const content = buffer.join('\n').trim();
    if (role && content) out.push(baseEvent({ ...context, index, type: 'message', role, content, timestamp: null, rawType: 'cursor-block' }));
    buffer = [];
  };
  lines.forEach((line, index) => {
    if (/^user:\s*$/i.test(line)) {
      flush(index);
      role = 'user';
    } else if (/^assistant:\s*$/i.test(line)) {
      flush(index);
      role = 'assistant';
    } else {
      buffer.push(line);
    }
  });
  flush(lines.length);
  return out;
}

export function normalizeTranscriptBuffer({ provider, sessionId, rawEntry, buffer }) {
  const text = buffer.toString('utf-8');
  const context = { provider, sessionId, rawEntry };
  const errors = [];
  let events = [];

  if (provider === 'cursor') {
    events = normalizeCursorText(text, context);
  } else if (text.trim().startsWith('{') && provider === 'gemini') {
    try {
      events = normalizeGeminiObject(JSON.parse(text), context);
    } catch (err) {
      errors.push({ type: 'normalization_failed', error: err.message });
    }
  } else {
    const parsed = parseJsonLines(text);
    errors.push(...parsed.errors.map((error) => ({ type: 'normalization_failed', ...error })));
    const passThrough = normalizeExistingMechRun(parsed.events, context);
    if (passThrough) {
      events = passThrough.events;
      errors.push(...passThrough.errors);
    }
    else if (provider === 'codex') events = normalizeCodex(parsed.events, context);
    else if (provider === 'claude') events = normalizeClaude(parsed.events, context);
    else errors.push({ type: 'normalization_failed', error: `unknown_provider:${provider}` });
  }

  if (events.length === 0 && errors.length === 0 && text.trim()) {
    errors.push({ type: 'normalization_failed', error: 'no_normalizable_events' });
  }
  return { events, errors };
}
