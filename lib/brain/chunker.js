/**
 * lib/brain/chunker.js
 *
 * Signal-based transcript chunker for brain.db ingestion.
 *
 * Ported from mech-plane/scripts/chunk-sessions.mjs (boundary detection logic)
 * and adapted for agentbootup's ingestion pipeline:
 *   - Self-contained (no mech-plane dependency)
 *   - Accepts raw JSONL lines (Claude/Cursor/Codex/Gemini transcript format)
 *   - Returns chunk objects shaped for brain.db INSERT
 *
 * Boundary detection rules (in priority order):
 *   F — Fixed window fallback (>= fixedWindowSize messages)
 *   A — Time gap > 5 minutes between consecutive messages
 *   B — Skill invocation pattern in user message
 *   C — Phase marker in user message ("now implement", "run tests", etc.)
 *   D — Tool-type shift after >= 15 messages in current chunk
 *   E — File set completely changed after >= 10 messages
 *
 * Exported API:
 *   chunkMessages(rawMessages, sessionId, options?) → Chunk[]
 *   classifyTool(name) → 'read' | 'edit' | 'bash' | 'other'
 *   detectBoundary(allMsgs, chunkStart, i, options?) → string | null
 */

// ── Constants ──────────────────────────────────────────────────────────────

const EDIT_TOOL_NAMES = new Set([
  'write', 'edit', 'apply_patch', 'search_replace', 'replace', 'write_file', 'edit_file',
  'notebookedit', 'notebook_edit',
]);

/** Skill name patterns — matched against user message text. */
const SKILL_PATTERNS = [
  { name: 'adversarial-reviewer',  patterns: [/adversari/i, /devil.?s.?advocate/i] },
  { name: 'dialectical',           patterns: [/dialecti/i, /player.?coach/i] },
  { name: 'prd-writer',            patterns: [/prd.?writer/i, /write.{0,10}prd/i, /create.{0,10}prd/i] },
  { name: 'task-processor',        patterns: [/task.?processor/i, /process.{0,10}task/i] },
  { name: 'tasklist-generator',    patterns: [/tasklist.?gen/i, /generate.{0,10}task/i] },
  { name: 'spec-writer',           patterns: [/spec.?writer/i, /write.{0,10}spec/i] },
  { name: 'brain-briefing',        patterns: [/brain.?brief/i] },
  { name: 'web-browse',            patterns: [/web.?browse\s*skill/i, /thinkbrowse\s*(cli|skill)/i] },
  { name: 'transcript-query',      patterns: [/transcript.?quer/i, /query.{0,10}transcript/i] },
  { name: 'memory-manager',        patterns: [/memory.?manager/i] },
  { name: 'self-improvement',      patterns: [/self.?improv/i] },
  { name: 'docs-generator',        patterns: [/docs.?gen/i, /generate.{0,10}docs/i] },
  { name: 'frontend-design',       patterns: [/frontend.?design/i, /design.?concept/i] },
  { name: 'cross-brain-message',   patterns: [/cross.?brain/i, /brain.?message/i] },
  { name: 'pr-review-loop',        patterns: [/pr.?review.?(loop|skill)/i, /review.?loop/i] },
  { name: 'agent-teams',           patterns: [/agent.?team/i] },
  { name: 'pattern-extractor',     patterns: [/pattern.?extract/i] },
];

const PHASE_MARKER_RE = /\b(now\s+implement|run\s+tests?|let'?s\s+review|push|adversarial|let'?s\s+implement|start\s+(implementing|coding|building))\b/i;
const CORRECTION_SIGNAL_RE = /\b(no|actually|instead|undo|revert|wrong)\b/i;

const DEFAULT_OPTIONS = {
  fixedWindowSize: 20,
  timeGapMs: 300_000,       // 5 minutes
  toolShiftMinChunk: 15,
  fileSetMinChunk: 10,
};

// ── Tool classification ────────────────────────────────────────────────────

/**
 * Map a tool name to a category.
 * @param {string | null | undefined} toolName
 * @returns {'read' | 'edit' | 'bash' | 'other'}
 */
export function classifyTool(toolName) {
  if (!toolName) return 'other';
  const n = String(toolName).toLowerCase();
  if (n === 'bash' || n === 'run' || n === 'execute' || n === 'terminal') return 'bash';
  if (EDIT_TOOL_NAMES.has(n)) return 'edit';
  if (n === 'read' || n === 'glob' || n === 'grep' || n === 'ls' || n === 'cat' ||
      n === 'head' || n === 'tail') return 'read';
  return 'other';
}

// ── Message pre-computation ────────────────────────────────────────────────

/**
 * Extract human-readable text from a message content block.
 * Skips tool_result blocks (API responses, not user utterances).
 *
 * @param {string | object[]} content
 * @returns {string}
 */
function extractHumanText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      if (item.type === 'text' && typeof item.text === 'string') return item.text;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * Collect tool_use blocks from a message content array.
 *
 * @param {unknown} content
 * @returns {{ name: string | null, input: object | null }[]}
 */
function collectToolUses(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((item) => item && typeof item === 'object' && item.type === 'tool_use')
    .map((item) => ({ name: item.name ?? null, input: item.input ?? null }));
}

/**
 * Pre-compute per-message fields needed by boundary detection.
 * Handles two JSONL shapes:
 *   1. Claude Code format: { message: { role, content, usage }, timestamp }
 *   2. Flat format:        { role, content, usage, timestamp }
 *
 * @param {object[]} rawMessages - parsed JSONL lines
 * @returns {PrecomputedMessage[]}
 */
export function precomputeMessages(rawMessages) {
  const result = [];
  for (const row of rawMessages) {
    if (!row || typeof row !== 'object') continue;

    // Normalise both JSONL shapes.
    const msg = row.message && typeof row.message === 'object' ? row.message : row;
    const { role, content, usage } = msg;
    if (role !== 'user' && role !== 'assistant') continue;

    const toolUses = collectToolUses(content);

    // Files touched = file_path / path inputs of edit/write tool uses.
    const filesTouched = [];
    for (const tu of toolUses) {
      if (tu.name && EDIT_TOOL_NAMES.has(String(tu.name).toLowerCase()) && tu.input) {
        const fp = tu.input.file_path || tu.input.path;
        if (typeof fp === 'string' && fp) filesTouched.push(fp);
      }
    }

    result.push({
      role,
      timestamp: row.timestamp ?? msg.timestamp ?? null,
      humanText: role === 'user' ? extractHumanText(content) : null,
      toolUses,
      filesTouched,
      tokenCounts: usage ? {
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      } : null,
    });
  }
  return result;
}

// ── Boundary detection ─────────────────────────────────────────────────────

/**
 * Returns the dominant tool type for a slice of pre-computed messages.
 * Dominant = the type that makes up > 50% of tool uses in that slice.
 * Returns null if no tool uses.
 *
 * @param {PrecomputedMessage[]} msgs
 * @returns {'read' | 'edit' | 'bash' | 'other' | null}
 */
function dominantToolType(msgs) {
  const counts = { read: 0, edit: 0, bash: 0, other: 0 };
  let total = 0;
  for (const m of msgs) {
    for (const tu of m.toolUses) {
      counts[classifyTool(tu.name)]++;
      total++;
    }
  }
  if (total === 0) return null;
  for (const [type, count] of Object.entries(counts)) {
    if (count / total > 0.5) return type;
  }
  return null;
}

/**
 * Detect a chunk boundary at message index `i`.
 *
 * Rules checked in priority order:
 *   F — fixed window fallback
 *   A — time gap
 *   B — skill invocation
 *   C — phase marker
 *   D — tool shift
 *   E — file set change
 *
 * @param {PrecomputedMessage[]} allMsgs
 * @param {number} chunkStart - index of first message in current chunk
 * @param {number} i - index being evaluated
 * @param {typeof DEFAULT_OPTIONS} opts
 * @returns {string | null} boundary reason, or null if no boundary
 */
export function detectBoundary(allMsgs, chunkStart, i, opts = DEFAULT_OPTIONS) {
  const chunkLen = i - chunkStart;

  // RULE F: fixed window
  if (chunkLen >= opts.fixedWindowSize) return 'fixed_window_fallback';

  const cur = allMsgs[i];
  const prev = i > 0 ? allMsgs[i - 1] : null;

  // RULE A: time gap > opts.timeGapMs
  if (prev && cur.timestamp && prev.timestamp) {
    const tCur = Date.parse(cur.timestamp);
    const tPrev = Date.parse(prev.timestamp);
    if (Number.isFinite(tCur) && Number.isFinite(tPrev) && (tCur - tPrev) > opts.timeGapMs) {
      return 'time_gap';
    }
  }

  // RULE B: skill invocation in user message
  if (cur.role === 'user' && cur.humanText) {
    for (const skill of SKILL_PATTERNS) {
      if (skill.patterns.some((p) => p.test(cur.humanText))) return 'skill_invocation';
    }
  }

  // RULE C: phase marker in user message
  if (cur.role === 'user' && cur.humanText && PHASE_MARKER_RE.test(cur.humanText)) {
    return 'phase_marker';
  }

  // RULE D: tool-type shift (requires >= toolShiftMinChunk messages in chunk)
  if (chunkLen >= opts.toolShiftMinChunk) {
    const chunkMsgs = allMsgs.slice(chunkStart, i);
    const last10 = chunkMsgs.slice(-10);
    const priorChunk = chunkMsgs.slice(0, Math.max(0, chunkMsgs.length - 10));
    const domLast10 = dominantToolType(last10);
    const domPrior = dominantToolType(priorChunk);
    if (domLast10 && domPrior && domLast10 !== domPrior) {
      // Strict check: last10 > 50%, prior < 30% for domLast10 type
      const counts10 = { read: 0, edit: 0, bash: 0, other: 0 };
      let total10 = 0;
      for (const m of last10) {
        for (const tu of m.toolUses) { counts10[classifyTool(tu.name)]++; total10++; }
      }
      const countsPrior = { read: 0, edit: 0, bash: 0, other: 0 };
      let totalPrior = 0;
      for (const m of priorChunk) {
        for (const tu of m.toolUses) { countsPrior[classifyTool(tu.name)]++; totalPrior++; }
      }
      if (total10 > 0 && totalPrior > 0) {
        const last10Ratio = counts10[domLast10] / total10;
        const priorRatio = countsPrior[domLast10] / totalPrior;
        if (last10Ratio > 0.5 && priorRatio < 0.3) return 'tool_shift';
      }
    }
  }

  // RULE E: file set completely changed (requires >= fileSetMinChunk messages in chunk)
  if (chunkLen >= opts.fileSetMinChunk) {
    const priorFiles = new Set();
    for (const m of allMsgs.slice(chunkStart, i)) {
      for (const f of m.filesTouched) priorFiles.add(f);
    }
    const newFiles = new Set(cur.filesTouched);
    if (priorFiles.size > 0 && newFiles.size >= 2) {
      let intersection = 0;
      for (const f of newFiles) { if (priorFiles.has(f)) intersection++; }
      if (intersection === 0) return 'file_set_change';
    }
  }

  return null;
}

// ── Phase and intent inference ─────────────────────────────────────────────

/**
 * @param {{ read: number, edit: number, bash: number, other: number }} toolCounts
 * @param {string[]} skillRefs
 * @param {string[]} userTexts
 * @returns {string}
 */
function inferPhaseHint(toolCounts, skillRefs, userTexts) {
  if (skillRefs.includes('adversarial-reviewer') || skillRefs.includes('dialectical')) return 'phase-gate';
  if (skillRefs.includes('pr-review-loop')) return 'pr-review';
  if (skillRefs.includes('tasklist-generator') || skillRefs.includes('prd-writer')) return 'planning';
  const total = toolCounts.read + toolCounts.edit + toolCounts.bash + toolCounts.other;
  if (total === 0) return 'planning';
  if (toolCounts.edit / total > 0.4 || toolCounts.bash / total > 0.4) return 'implementation';
  if (toolCounts.read / total > 0.6) return 'context_recovery';
  return 'general';
}

/**
 * @param {string[]} userTexts
 * @returns {string}
 */
function inferIntentHint(userTexts) {
  const combined = userTexts.join(' ').toLowerCase();
  if (combined.includes('implement') || combined.includes('create') || combined.includes('build')) return 'implementation';
  if (combined.includes('fix') || combined.includes('error') || combined.includes('bug') || combined.includes('test')) return 'debugging';
  if (combined.includes('review') || combined.includes('read')) return 'review';
  if (combined.includes('plan') || combined.includes('next step') || combined.includes('what should')) return 'planning';
  return 'general';
}

// ── Core chunking algorithm ────────────────────────────────────────────────

/**
 * Segment a transcript's raw JSONL messages into signal-based chunks.
 *
 * @param {object[]} rawMessages - parsed JSONL lines from a transcript file
 * @param {string}   sessionId   - session identifier (used in chunk IDs)
 * @param {object}   [options]
 * @param {number}   [options.fixedWindowSize=20]
 * @param {number}   [options.timeGapMs=300_000]
 * @param {number}   [options.toolShiftMinChunk=15]
 * @param {number}   [options.fileSetMinChunk=10]
 * @param {string}   [options.sourceCli='claude']
 * @param {string}   [options.sourcePath='']
 *
 * @returns {Chunk[]}
 */
export function chunkMessages(rawMessages, sessionId, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const sourceCli = options.sourceCli ?? 'claude';
  const sourcePath = options.sourcePath ?? '';

  const precomputed = precomputeMessages(rawMessages);
  if (precomputed.length === 0) return [];

  const chunks = [];
  let chunkStart = 0;

  /**
   * Finalize the current chunk slice [chunkStart, endExclusive).
   * @param {number} endExclusive
   * @param {string} boundaryReason
   */
  function finalizeChunk(endExclusive, boundaryReason) {
    const msgs = precomputed.slice(chunkStart, endExclusive);
    if (msgs.length === 0) return;

    // User texts for content + hints
    const userTexts = msgs
      .filter((m) => m.role === 'user' && m.humanText)
      .map((m) => m.humanText);

    // Tool counts
    const toolCounts = { read: 0, edit: 0, bash: 0, other: 0 };
    for (const m of msgs) {
      for (const tu of m.toolUses) toolCounts[classifyTool(tu.name)]++;
    }

    // Files touched
    const filesSet = new Set();
    for (const m of msgs) { for (const f of m.filesTouched) filesSet.add(f); }
    const filesTouched = [...filesSet].sort();

    // Skill refs from user texts
    const skillRefsFound = new Set();
    for (const skill of SKILL_PATTERNS) {
      if (userTexts.some((t) => skill.patterns.some((p) => p.test(t)))) {
        skillRefsFound.add(skill.name);
      }
    }
    const skillRefs = [...skillRefsFound].sort();

    // Token counts
    let tokenCount = 0;
    for (const m of msgs) {
      if (m.tokenCounts) {
        tokenCount += m.tokenCounts.input_tokens + m.tokenCounts.output_tokens;
      }
    }

    // Correction signals
    let correctionCount = 0;
    for (const t of userTexts) {
      if (CORRECTION_SIGNAL_RE.test(t)) correctionCount++;
    }

    // Timestamps
    const timestamps = msgs.map((m) => m.timestamp).filter(Boolean);
    const startedAt = timestamps[0] ?? null;
    const endedAt = timestamps[timestamps.length - 1] ?? null;

    // First timestamp as unix ms (for db.timestamp column)
    let timestampMs = null;
    if (startedAt) {
      const parsed = Date.parse(startedAt);
      if (Number.isFinite(parsed)) timestampMs = parsed;
    }

    const chunkIndex = chunks.length;
    const id = `${sessionId}__c${String(chunkIndex).padStart(3, '0')}`;

    // Content = concatenated user texts (FTS5 search target)
    const content = userTexts.join('\n\n').trim();

    chunks.push({
      id,
      session_id: sessionId,
      chunk_index: chunkIndex,
      message_count: msgs.length,
      started_at: startedAt,
      ended_at: endedAt,
      timestamp_ms: timestampMs,
      content,
      token_count: tokenCount,
      chunk_meta: {
        boundary_reason: boundaryReason,
        session_phase_hint: inferPhaseHint(toolCounts, skillRefs, userTexts),
        intent_hint: inferIntentHint(userTexts),
        files_touched: filesTouched,
        skill_refs: skillRefs,
        tool_counts: toolCounts,
        correction_count: correctionCount,
        message_count: msgs.length,
        source_cli: sourceCli,
        source_path: sourcePath,
      },
    });

    chunkStart = endExclusive;
  }

  // Walk messages, emit boundary when detected
  for (let i = 1; i < precomputed.length; i++) {
    const reason = detectBoundary(precomputed, chunkStart, i, opts);
    if (reason) finalizeChunk(i, reason);
  }

  // Finalize trailing chunk
  if (chunkStart < precomputed.length) {
    finalizeChunk(precomputed.length, 'end_of_session');
  }

  // Back-fill total_chunks count in each chunk_meta
  const total = chunks.length;
  for (const chunk of chunks) {
    chunk.chunk_meta.total_chunks_in_session = total;
  }

  return chunks;
}
