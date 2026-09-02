#!/usr/bin/env bun
/**
 * Collab Session Orchestrator — stateful player-coach iteration loop.
 *
 * A collab session is an ongoing working relationship, not a pipeline.
 * APPROVE is a checkpoint (saves artifact, stays OPEN), not a terminal state.
 *
 * Commands:
 * Preferred entrypoint:
 *   bun scripts/collab-session.ts start <topic-file.md> [--dry-run] [--mode autonomous|director] [--max-rounds N]
 *   bun scripts/collab-session.ts resume <session-id>
 *   bun scripts/collab-session.ts list
 *   bun scripts/collab-session.ts log <session-id>
 *   bun scripts/collab-session.ts close <session-id>
 *
 * Legacy entrypoint still supported:
 *   bun brain/collab-session.ts ...
 *
 * State machine (director mode):
 *   OPEN → PLAYER_TURN → COACH_TURN → DIRECTOR → APPROVED → OPEN (loop)
 *                                              ↘ PAUSED (exits)
 *                                              ↘ CLOSED (archives)
 *
 * State machine (autonomous mode):
 *   OPEN → PLAYER_TURN → COACH_TURN → PLAYER_TURN (REVISE, round < max_rounds)
 *                                  ↘ COMPLETE     (APPROVE)
 *                                  ↘ STALLED      (BLOCK | REVISE at max_rounds | error)
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join, resolve, sep, dirname } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';
import { DEV_DIR, KNOWN_REPOS } from './lib/collab-session/agent-repos';

// ─── Types ───────────────────────────────────────────────────────────────────

export type SessionState =
  | 'OPEN'
  | 'PLAYER_TURN'
  | 'COACH_TURN'
  | 'DIRECTOR'
  | 'APPROVED'
  | 'PAUSED'
  | 'CLOSED'
  | 'COMPLETE'
  | 'STALLED';

export interface CollabEvent {
  ts: string;
  event: 'state_transition';
  payload: { from: SessionState; to: SessionState };
}

type CoachVerdict = 'APPROVE' | 'REVISE' | 'BLOCK';

export interface Iteration {
  round: number;
  player_output: string;   // inline content, or "file:<path>" when > FILE_THRESHOLD_BYTES
  coach_verdict: CoachVerdict | null;
  coach_feedback: string;  // inline content, or "file:<path>" when > FILE_THRESHOLD_BYTES
  coach_quality: number | null; // 1-10, populated on APPROVE
  director_instruction: string | null;
  artifact_id: string | null; // populated on APPROVE
  timestamp: string;
}

export interface CollabSession {
  id: string; // cs_<timestamp>
  topic: string;
  player: string; // agent ID e.g. helloconvo.gm
  coach: string; // agent ID e.g. mech-browse.gm
  brief: string; // current working brief (may be appended by coach feedback or rewritten on redirect)
  original_brief: string; // set once at createSession(), never mutated — used by log/resume display
  context_artifacts: string[]; // AgentDrive artifact IDs
  state: SessionState;
  round: number; // monotonic session counter — never resets on redirect (avoids iteration ID conflicts)
  iterations: Iteration[];
  created_at: string;
  last_active: string;
  // Autonomous mode fields
  mode: 'director' | 'autonomous';
  coachType: 'brain' | 'script'; // 'script' runs coach as a local executable
  max_rounds: number; // autonomous mode only; total rounds before STALLED (round 1 = first player turn)
  /** Notification target on COMPLETE/STALLED. Prefix `./` or `/` for file-path channel (parent dir is created if needed); bare string routes to ADMP. Note: `~/` paths are not treated as file paths — use an absolute or `./`-relative path. */
  notify?: string;
  last_approved_artifact_id?: string | null;
  defaults?: {
    provider?: string;
    model?: string;
  };
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SESSIONS_DIR = join(import.meta.dir, '..', '.brain', 'collab', 'sessions');
const ROUNDS_BASE_DIR = join(import.meta.dir, '..', '.brain', 'collab', 'rounds');
const FILE_THRESHOLD_BYTES = 4 * 1024; // outputs > 4 KB stored on disk, inline otherwise
const LEGACY_SESSIONS_DIRS = [
  join(import.meta.dir, '..', '.brain', 'sessions'),
  join(import.meta.dir, '..', 'brain', 'sessions'),
] as const;
const _agentdriveRaw = process.env.AGENTDRIVE_BASE ?? 'https://agentdrive.fly.dev';
try {
  const _u = new URL(_agentdriveRaw);
  const isLocalDev = _u.hostname === 'localhost' || _u.hostname === '127.0.0.1';
  if (_u.protocol !== 'https:' && !isLocalDev) throw new Error('must be https (or localhost for dev)');
} catch (e) {
  if (e instanceof Error && e.message.includes('must be https')) throw e;
  throw new Error(`AGENTDRIVE_BASE is not a valid URL: ${_agentdriveRaw}`);
}
const AGENTDRIVE_BASE = _agentdriveRaw.replace(/\/$/, '');
const SPAWN_TIMEOUT_MS = 8 * 60 * 1000; // 8 min per brain
const BRAIN_DB_STALE_HOURS = 24;
const BRIEF_MAX = 50_000; // max chars for accumulated session.brief (truncates oldest context on overflow)

// Exhaustiveness-checked: if SessionState gains a new variant, this satisfies check
// will fail at compile time, forcing VALID_STATES to be updated in lockstep.
const ALL_SESSION_STATES = [
  'OPEN', 'PLAYER_TURN', 'COACH_TURN', 'DIRECTOR',
  'APPROVED', 'PAUSED', 'CLOSED', 'COMPLETE', 'STALLED',
] as const satisfies readonly SessionState[]; // membership enforced at compile time; add here if SessionState grows
const VALID_STATES = new Set<string>(ALL_SESSION_STATES);

const PLAYER_MD = 'player.md';
const COACH_MD  = 'coach.md';

function playerFilePath(sessionId: string, round: number): string {
  return join(roundsDir(sessionId, round), PLAYER_MD); // nosemgrep: path-join-resolve-traversal (roundsDir validates IDs)
}
function coachFilePath(sessionId: string, round: number): string {
  return join(roundsDir(sessionId, round), COACH_MD); // nosemgrep: path-join-resolve-traversal (roundsDir validates IDs)
}

// ─── Event Log + Round Dir Helpers ───────────────────────────────────────────

export function eventsPath(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`Invalid session ID: ${id}`);
  return join(SESSIONS_DIR, `${id}.events.jsonl`); // nosemgrep: path-join-resolve-traversal
}

// Returns the rounds dir path — callers must mkdirSync(roundsDir(...), { recursive: true }) before writing.
export function roundsDir(id: string, round: number): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`Invalid session ID: ${id}`);
  if (!Number.isInteger(round) || round < 1) throw new Error(`Invalid round: ${round}`);
  return join(ROUNDS_BASE_DIR, id, String(round)); // nosemgrep: path-join-resolve-traversal
}

export function appendEvent(id: string, from: SessionState, to: SessionState): void {
  try {
    const event: CollabEvent = { ts: new Date().toISOString(), event: 'state_transition', payload: { from, to } };
    const line = JSON.stringify(event) + '\n';
    const path = eventsPath(id);
    if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
    appendFileSync(path, line); // O(1) append — avoids read-then-write as events accumulate
  } catch (err) {
    console.warn(`  [warn] appendEvent failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Round File Helpers ───────────────────────────────────────────────────────

/**
 * Writes player.md and coach.md under .brain/collab/rounds/<id>/<round>/.
 * Pass empty string for content not yet available (e.g. player side before coach runs).
 * Returns the paths for embedding in Iteration as file: references.
 */
export function saveRoundFiles(
  sessionId: string,
  round: number,
  player: string,
  coach: string,
): { playerPath: string; coachPath: string } {
  const dir = roundsDir(sessionId, round);
  mkdirSync(dir, { recursive: true });
  const playerPath = playerFilePath(sessionId, round);
  const coachPath = coachFilePath(sessionId, round);
  if (player) writeFileSync(playerPath, player);
  if (coach) writeFileSync(coachPath, coach);
  return { playerPath, coachPath };
}

/** Resolves a "file:<path>" reference to its string content. Falls back to the raw value on error. */
export function resolveFileRef(value: string): string {
  if (!value.startsWith('file:')) return value;
  const filePath = value.slice(5); // strip "file:"
  try {
    // Restrict reads to ROUNDS_BASE_DIR — prevents hand-edited session JSONs from reading
    // arbitrary filesystem paths via a crafted "file:/etc/passwd" reference.
    const resolvedPath = resolve(filePath); // nosemgrep: path-join-resolve-traversal (bounds-checked against ROUNDS_BASE_DIR below)
    const roundsBase = resolve(ROUNDS_BASE_DIR);
    if (!resolvedPath.startsWith(roundsBase + sep) && resolvedPath !== roundsBase) {
      console.warn(`  [warn] resolveFileRef: "${filePath}" is outside rounds dir — refusing`);
      return value;
    }
    return readFileSync(resolvedPath, 'utf-8');
  } catch {
    console.warn(`  [warn] resolveFileRef: cannot read "${filePath}" — using inline fallback`);
    return value;
  }
}

// ─── Notifications (T4) ──────────────────────────────────────────────────────

const BRAIN_MSG_PATH = join(import.meta.dir, '..', '.claude', 'skills', 'cross-brain-message', 'brain-msg.ts');

export async function sendNotification(session: CollabSession): Promise<void> {
  if (!session.notify) return;

  const subject = `Collab session ${session.state}: ${session.topic ?? '(no topic)'}`;

  const lastIteration = session.iterations[session.iterations.length - 1];
  const body: Record<string, unknown> = { sessionId: session.id, round: session.round, state: session.state };
  if (lastIteration?.artifact_id) body.artifactId = lastIteration.artifact_id;

  try {
    // Resolve inside try so a deleted file: ref is caught and reported with context
    if (lastIteration?.coach_feedback) body.lastFeedback = resolveFileRef(lastIteration.coach_feedback);

    const target = session.notify;
    // File-path channel: prefix './' or '/' → filesystem. '~/' and bare names → ADMP.
    if (target.startsWith('./') || target.startsWith('/')) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify({ subject, body }, null, 2));
      console.log(`  [notify] wrote notification to ${target}`);
    } else {
      if (target.startsWith('~/')) {
        console.warn('  [notify] "~/" paths are not expanded — aborting notification. Use an absolute path or "./" prefix for file output.');
        return;
      }
      // ADMP agent ID — 10s kill guard (brain-msg.ts has no built-in timeout)
      if (!existsSync(BRAIN_MSG_PATH)) {
        console.warn(`  [notify] brain-msg.ts not found at expected path — ADMP channel unavailable. Install cross-brain-message skill.`);
        return;
      }
      const proc = Bun.spawn(
        ['bun', BRAIN_MSG_PATH, 'send', '--to', target, '--type', 'notification', '--subject', subject, '--body', JSON.stringify(body)],
        { stdout: 'ignore', stderr: 'pipe' },
      );
      const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) { console.warn('  [notify] SIGKILL failed:', e); } }, 10_000);
      try {
        const [exitCode, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
        if (exitCode !== 0) {
          console.warn(`  [notify] brain-msg send failed (exit ${exitCode}): ${err.slice(-200)}`);
        } else {
          console.log(`  [notify] sent to ${target}`);
        }
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (err) {
    console.warn(`  [notify] sendNotification failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Session File I/O ────────────────────────────────────────────────────────

export function sessionPath(id: string): string {
  // Validate ID before joining — prevents path traversal from CLI input
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`Invalid session ID: ${id}`);
  return join(SESSIONS_DIR, `${id}.json`); // nosemgrep: path-join-resolve-traversal
}

function loadSession(id: string): CollabSession {
  const primaryPath = sessionPath(id);
  const legacyPaths = LEGACY_SESSIONS_DIRS.map((dir) => join(dir, `${id}.json`)); // nosemgrep: path-join-resolve-traversal
  const path = [primaryPath, ...legacyPaths].find((candidate) => existsSync(candidate)) ?? primaryPath;
  if (!existsSync(path)) throw new Error(`Session not found: ${id}`);
  let raw: CollabSession;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8')) as CollabSession;
  } catch {
    throw new Error(`Session file is malformed (corrupt JSON): ${path}\nDelete it with: rm ${path}`);
  }
  // Note: reconcileEvents may write state.json if events.jsonl is ahead (crash recovery)
  return reconcileEvents(migrateSession(raw));
}

/**
 * Compares state.json against the last event in events.jsonl.
 * If the crash window left state.json behind (events record a later state), restores it.
 * Idempotent: safe to call on every load; no-op when state matches or events file is absent.
 */
export function reconcileEvents(session: CollabSession): CollabSession {
  const epath = eventsPath(session.id);
  if (!existsSync(epath)) return session; // pre-T1 legacy session: no events file

  let lastLine: string | undefined;
  try {
    const lines = readFileSync(epath, 'utf-8').split('\n').filter(l => l.trim());
    lastLine = lines[lines.length - 1];
  } catch {
    return session; // unreadable events file: leave state unchanged
  }
  if (!lastLine) return session; // empty events file

  let lastEvent: CollabEvent;
  try {
    lastEvent = JSON.parse(lastLine) as CollabEvent;
  } catch {
    return session; // malformed last line: leave state unchanged
  }

  const rawIntended = lastEvent.payload?.to;
  if (typeof rawIntended !== 'string' || !VALID_STATES.has(rawIntended)) return session; // unknown schema version
  const intendedState = rawIntended as SessionState;
  if (intendedState === session.state) return session; // no divergence

  console.warn(`  [recover] state.json says "${session.state}" but last event says to="${intendedState}" — restoring`);

  // Idempotency hint: log when round files already exist so runRound can skip re-spawn
  const playerExists = intendedState === 'PLAYER_TURN' && existsSync(playerFilePath(session.id, session.round));
  const coachExists  = intendedState === 'COACH_TURN'  && existsSync(coachFilePath(session.id, session.round));
  if (playerExists) console.log(`  [recover] ${PLAYER_MD} exists for round ${session.round} — runRound will skip re-spawn`);
  if (coachExists)  console.log(`  [recover] ${COACH_MD} exists for round ${session.round} — runRound will skip re-spawn`);

  const recovered = { ...session, state: intendedState };
  try {
    saveSession(recovered); // recovery write — no prevState: not a new event, just correcting state.json
  } catch (err) {
    // SESSIONS_DIR suddenly read-only or disk full — log and continue with in-memory correction
    console.error(`  [recover] failed to persist corrected state (${err instanceof Error ? err.message : String(err)}) — resuming with in-memory correction only`);
  }
  return recovered;
}

// Backfills defaults for fields added in T1 so downstream code can trust the type
// without null guards on every access. Old sessions on disk won't have these fields.
function migrateSession(s: CollabSession): CollabSession {
  return {
    ...s,
    mode: s.mode ?? 'director',
    coachType: s.coachType ?? 'brain',
    max_rounds: s.max_rounds ?? 5,
    original_brief: s.original_brief ?? s.brief ?? '',
    last_approved_artifact_id: s.last_approved_artifact_id ?? null,
  };
}

/**
 * Persists session to state.json. When `prevState` is provided and differs from
 * `session.state`, also appends a transition event to events.jsonl via `appendEvent`.
 * Omit `prevState` for writes that are not state transitions (e.g. crash recovery,
 * round counter bumps, or `reconcileEvents` corrective writes).
 * Note: `appendEvent` may also be called directly for same-state markers (from === to)
 * that cannot be routed through this function's `prevState !== session.state` guard.
 *
 * Event-first ordering: the event is written BEFORE state.json so that if the
 * state.json write is interrupted, reconcileEvents can restore the intended state
 * on the next load (the event records where we were heading).
 */
function saveSession(session: CollabSession, prevState?: SessionState): void {
  if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
  if (prevState !== undefined && prevState !== session.state) {
    appendEvent(session.id, prevState, session.state);
  }
  const toWrite = { ...session, last_active: new Date().toISOString() };
  writeFileSync(sessionPath(session.id), JSON.stringify(toWrite, null, 2));
  session.last_active = toWrite.last_active; // sync back only after successful write
}

export function listSessions(): CollabSession[] {
  const dirs = [SESSIONS_DIR, ...LEGACY_SESSIONS_DIRS].filter((dir, index, arr) =>
    existsSync(dir) && arr.indexOf(dir) === index
  );
  if (dirs.length === 0) return [];

  const byId = new Map<string, CollabSession>();
  for (const dir of dirs) {
    for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
      try {
        const session = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as CollabSession; // nosemgrep: path-join-resolve-traversal (f is from readdirSync, not user input)
        if (!byId.has(session.id) || dir === SESSIONS_DIR) {
          byId.set(session.id, session);
        }
      } catch {
        console.warn(`  [warn] Skipping malformed session file: ${f}`);
      }
    }
  }

  return [...byId.values()]
    .sort((a, b) => b.last_active.localeCompare(a.last_active));
}

// ─── Topic File Parser ───────────────────────────────────────────────────────

interface TopicFile {
  topic: string;
  player: string;
  coach: string;
  context_artifacts: string[];
  brief: string;
  mode?: 'director' | 'autonomous';
  coachType?: 'brain' | 'script';
  max_rounds?: number;
  notify?: string;
  defaults?: {
    provider?: string;
    model?: string;
  };
}

export function parseTopicFile(filePath: string): TopicFile {
  if (!existsSync(filePath)) throw new Error(`Topic file not found: ${filePath}`);
  const raw = readFileSync(filePath, 'utf-8');

  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!fmMatch) throw new Error(`Topic file must have YAML frontmatter: ${filePath}`);

  const fm = fmMatch[1];
  const body = fmMatch[2].trim();

  const get = (key: string): string => {
    const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm')); // nosemgrep: detect-non-literal-regexp (key is always a hardcoded string literal at call sites)
    if (!m) return '';
    const raw = m[1].trim();
    // Quoted scalar: backreference enforces matching quotes; optional trailing comment is discarded.
    // Captures: (1) quote char, (2) value, handles `"foo" # note` and `"release # 5"` correctly.
    const quoted = raw.match(/^(["'])(.*?)\1\s*(?:#.*)?$/);
    if (quoted) return quoted[2]!;
    // Unquoted scalar: strip trailing inline YAML comment, then trim
    return raw.replace(/\s+#.*$/, '').trimEnd();
  };
  const getArray = (key: string): string[] => {
    // Inline array: participants: [a, b]
    const inline = fm.match(new RegExp(`^${key}:\\s*\\[(.+)\\]$`, 'm')); // nosemgrep: detect-non-literal-regexp (key is always a hardcoded string literal at call sites)
    if (inline) return inline[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
    // Block array: participants:\n  - a\n  - b
    const blockHeader = fm.match(new RegExp(`^${key}:\\s*$`, 'm')); // nosemgrep: detect-non-literal-regexp
    if (!blockHeader) return [];
    const afterKey = fm.slice(blockHeader.index! + blockHeader[0].length);
    // Collect only lines belonging to this key's block. Stop at first non-blank,
    // non-indented line (which starts the next YAML key).
    const blockLines: string[] = [];
    for (const line of afterKey.split('\n')) {
      if (line !== '' && !/^[ \t]/.test(line)) break;
      blockLines.push(line);
    }
    const items = [...blockLines.join('\n').matchAll(/^[ \t]+-[ \t]+(.+)$/mg)]
      .map(m => m[1].trim().replace(/^["']|["']$/g, ''));
    return items;
  };

  const topic = get('topic');
  const participants = getArray('participants');
  const context_artifacts = getArray('context_artifacts');

  // participants: [player, coach] — first is player, second is coach
  if (participants.length < 2) {
    throw new Error(`Topic file needs at least 2 participants: [player, coach]. Got: ${JSON.stringify(participants)}`);
  }

  // Parse optional defaults block for provider/model selection
  const defaults: { provider?: string; model?: string } = {};
  const defaultsMatch = fm.match(/^defaults:\s*\n((?:  \w+:.+\n?)+)/m);
  if (defaultsMatch) {
    const defaultsBlock = defaultsMatch[1];
    const providerMatch = defaultsBlock.match(/^  provider:\s*(\S+)/m);
    const modelMatch = defaultsBlock.match(/^  model:\s*(\S+)/m);
    if (providerMatch) defaults.provider = providerMatch[1];
    if (modelMatch) defaults.model = modelMatch[1];
  }

  // Parse autonomous mode fields
  const modeRaw = get('mode');
  const mode: 'director' | 'autonomous' | undefined =
    modeRaw === 'autonomous' ? 'autonomous' : modeRaw === 'director' ? 'director' : undefined;

  const coachTypeRaw = get('coachType');
  const coachType: 'brain' | 'script' | undefined =
    coachTypeRaw === 'script' ? 'script' : coachTypeRaw === 'brain' ? 'brain' : undefined;

  const maxRoundsRaw = get('max_rounds');
  const max_rounds = maxRoundsRaw && /^\d+$/.test(maxRoundsRaw)
    ? (() => { const n = Number(maxRoundsRaw); return Number.isSafeInteger(n) && n > 0 ? n : undefined; })()
    : undefined;

  const notifyRaw = get('notify');
  const notify = notifyRaw && notifyRaw !== 'false' ? notifyRaw : undefined;

  return {
    topic,
    player: participants[0],
    coach: participants[1],
    context_artifacts,
    brief: body,
    mode,
    coachType,
    max_rounds,
    notify,
    defaults,
  };
}

function createSession(topicFile: TopicFile, overrides?: { mode?: 'director' | 'autonomous'; max_rounds?: number }): CollabSession {
  const id = `cs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const mode = overrides?.mode ?? topicFile.mode ?? 'director';
  const max_rounds = overrides?.max_rounds ?? topicFile.max_rounds ?? 5;
  const session: CollabSession = {
    id,
    topic: topicFile.topic,
    player: topicFile.player,
    coach: topicFile.coach,
    brief: topicFile.brief,
    original_brief: topicFile.brief, // immutable — never overwritten
    context_artifacts: topicFile.context_artifacts,
    state: 'OPEN',
    round: 0,
    iterations: [],
    created_at: now,
    last_active: now,
    mode,
    coachType: topicFile.coachType ?? 'brain',
    max_rounds,
    notify: topicFile.notify,
    last_approved_artifact_id: null,
    defaults: topicFile.defaults,
  };
  saveSession(session);
  return session;
}

// ─── Prompt Builders ─────────────────────────────────────────────────────────

function buildPlayerPrompt(session: CollabSession): string {
  const priorContext = session.iterations.length > 0
    ? [
        '',
        '## Prior Iteration History',
        ...session.iterations.map(it => [
          `### Round ${it.round}`,
          it.coach_verdict ? `Coach verdict: ${it.coach_verdict}` : '',
          it.coach_feedback ? `Coach feedback:\n${resolveFileRef(it.coach_feedback)}` : '',
          it.director_instruction ? `Director instruction for this round:\n${it.director_instruction}` : '',
        ].filter(Boolean).join('\n')),
      ].join('\n')
    : '';

  const artifactSection = session.context_artifacts.length > 0
    ? `\n## Context Artifacts\nFetch these from AgentDrive before starting:\n${session.context_artifacts.map(id => `  bun .claude/skills/agentdrive/agentdrive.ts get ${id}`).join('\n')}\n`
    : '';

  const brainSearchNote = `
## Context Lookup
Before writing, search your transcript history for prior work on this topic:
  bun scripts/lib/collab-session/brain-search.ts "${session.topic}" --corrections-only --limit 5
This is especially important if you have worked on this before — don't start cold.
`;

  return [
    `You are ${session.player}, working on a player-coach collaboration session.`,
    '',
    '## Your Role',
    'You are the PLAYER. You produce the work. A coach will review your output and give a verdict.',
    'Write directly and concisely. Your ENTIRE output will be passed to the coach.',
    'Do not include meta-commentary, tool traces, or reasoning steps — only the deliverable.',
    '',
    artifactSection,
    brainSearchNote,
    '## Brief',
    session.brief,
    priorContext,
    '',
    '## Output Format',
    'Produce your deliverable now. Start with the content directly — no preamble.',
  ].join('\n');
}

function buildCoachPrompt(session: CollabSession, playerOutput: string): string {
  const priorRounds = session.iterations.length > 0
    ? [
        '',
        '## Prior Rounds',
        ...session.iterations.map(it => {
          const playerText = resolveFileRef(it.player_output);
          const feedbackText = it.coach_feedback ? resolveFileRef(it.coach_feedback) : '';
          return [
            `### Round ${it.round} — ${it.coach_verdict ?? 'pending'}`,
            `Player output:\n${playerText.slice(0, 800)}${playerText.length > 800 ? '...' : ''}`,
            feedbackText ? `Your feedback:\n${feedbackText}` : '',
          ].filter(Boolean).join('\n');
        }),
      ].join('\n')
    : '';

  return [
    `You are ${session.coach}, acting as COACH in a player-coach collaboration.`,
    '',
    '## Your Role',
    `Review ${session.player}'s output against the brief and product reality. You own the product truth.`,
    'Be specific. "Make it better" is not useful feedback — point to exact words or claims.',
    '',
    session.context_artifacts.length > 0
      ? `## Context Artifacts\nFetch these from AgentDrive for product truth reference:\n${session.context_artifacts.map(id => `  bun .claude/skills/agentdrive/agentdrive.ts get ${id}`).join('\n')}\n`
      : '',
    '## The Brief',
    session.brief,
    priorRounds,
    '',
    `## ${session.player}'s Output (Round ${session.round})`,
    playerOutput,
    '',
    '## Required Response Format',
    'Respond with EXACTLY this structure:',
    '',
    'VERDICT: APPROVE | REVISE | BLOCK',
    '',
    'If REVISE or BLOCK:',
    'FEEDBACK:',
    '- [issue]: what to fix and why',
    '',
    'If APPROVE:',
    'QUALITY: [1-10]',
    'NOTES: what works about this version',
  ].join('\n');
}

// ─── Verdict Parser ──────────────────────────────────────────────────────────

export function parseCoachVerdict(output: string): { verdict: CoachVerdict; feedback: string; quality: number | null } {
  const verdictMatch = output.match(/VERDICT:\s*(APPROVE|REVISE|BLOCK)/i);
  if (!verdictMatch) {
    console.warn('  [warn] Coach output has no VERDICT line — defaulting to REVISE. Raw output:\n', output.slice(0, 200));
  }
  const verdict = (verdictMatch?.[1]?.toUpperCase() ?? 'REVISE') as CoachVerdict;

  const qualityMatch = output.match(/QUALITY:\s*(\d+)/i);
  const rawQ = qualityMatch ? parseInt(qualityMatch[1], 10) : null;
  const quality = rawQ !== null && rawQ >= 1 && rawQ <= 10 ? rawQ : null;
  if (rawQ !== null && quality === null) {
    console.warn(`  [warn] Coach quality score ${rawQ} out of 1-10 range — ignoring`);
  }

  // Extract feedback block (everything after FEEDBACK: or NOTES:)
  const feedbackMatch = output.match(/(?:FEEDBACK:|NOTES:)([\s\S]*)/i);
  const feedback = feedbackMatch ? feedbackMatch[1].trim() : output.trim();

  return { verdict, feedback, quality };
}

// ─── Script Coach ────────────────────────────────────────────────────────────

/**
 * Runs a local executable as the coach.
 * - Resolves scriptPath relative to repo root when not absolute.
 * - Passes playerOutput via stdin; PLAYER_OUTPUT env var also set for convenience.
 * - Exit 0 → APPROVE; non-zero → REVISE; stdout is the feedback string.
 * - On timeout → kills the process and returns BLOCK with timeout message.
 */
export async function runScriptCoach(
  scriptPath: string,
  playerOutput: string,
  timeoutMs: number,
): Promise<{ verdict: CoachVerdict; feedback: string }> {
  // Resolve relative paths from repo root (one level up from scripts/)
  const repoRoot = join(import.meta.dir, '..');
  const resolvedPath = scriptPath.startsWith('/') ? scriptPath : join(repoRoot, scriptPath); // nosemgrep: path-join-resolve-traversal (scriptPath from trusted topic file authored by operator)

  if (!existsSync(resolvedPath)) {
    return { verdict: 'BLOCK', feedback: `coach script not found: ${resolvedPath}` };
  }

  const proc = Bun.spawn([resolvedPath], {
    env: { ...process.env, PLAYER_OUTPUT: playerOutput },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Write playerOutput to stdin, then close so the script can read EOF (Bun FileSink API)
  proc.stdin.write(playerOutput);
  proc.stdin.end();

  // Start draining stdout/stderr BEFORE awaiting exit — prevents pipe-buffer deadlock
  // when the script writes more than the OS pipe buffer (~64 KB) to either stream.
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill('SIGKILL'); } catch {}
  }, timeoutMs);

  const exitCode = await proc.exited;
  clearTimeout(timer);

  if (timedOut) {
    // Do not await streams after a forced kill — stdout/stderr pipes may not flush cleanly.
    // Attach no-op catch handlers to prevent unhandledRejection if the pipe tears on SIGTERM.
    stdoutPromise.catch(() => {});
    stderrPromise.catch(() => {});
    return { verdict: 'BLOCK', feedback: `coach script timed out after ${timeoutMs}ms` };
  }

  // Normal exit — drain both streams. This resolves cleanly because the process has exited
  // and all its file descriptors are closed.
  const [stdoutText] = await Promise.all([stdoutPromise, stderrPromise]);
  // exit 0 → APPROVE, exit 2 → BLOCK (hard stop), any other non-zero → REVISE
  const verdict: CoachVerdict = exitCode === 0 ? 'APPROVE' : exitCode === 2 ? 'BLOCK' : 'REVISE';
  return { verdict, feedback: stdoutText.trim() };
}

// ─── Brain Spawn ─────────────────────────────────────────────────────────────

function findClaude(): string {
  const which = Bun.which('claude');
  if (which) return which;
  for (const c of [
    join(homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ]) {
    if (existsSync(c)) return c;
  }
  throw new Error('claude binary not found');
}

async function runBrainWithPrompt(
  agentId: string,
  prompt: string,
  dryRun = false,
  provider = 'claude-code',
  model?: string,
): Promise<string> {
  // Topic files use .gm-suffixed IDs (e.g. "helloconvo.gm") but KNOWN_REPOS uses bare IDs.
  const canonicalId = agentId.replace(/\.gm$/, '');
  const repoPath = KNOWN_REPOS[agentId] ?? KNOWN_REPOS[canonicalId];
  if (!repoPath) throw new Error(`Unknown agent: ${agentId}. Add to scripts/lib/collab-session/agent-repos.ts`);
  if (!existsSync(repoPath)) throw new Error(`Repo path not found for ${agentId}: ${repoPath}`);

  // Log provider/model info
  const modelInfo = model ? ` (${model})` : '';
  console.log(`  [spawn] ${agentId} via ${provider}${modelInfo}...`);

  if (dryRun) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`[dry-run] Would spawn ${agentId} in ${repoPath}`);
    console.log(`Provider: ${provider}${modelInfo}`);
    console.log(`Prompt preview (first 500 chars):\n${prompt.slice(0, 500)}...`);
    console.log('─'.repeat(60));
    return `[dry-run] Simulated output from ${agentId}`;
  }

  // Try mech-run first with raw prompt (no round-table framing wrapper).
  // We invoke mech-run spawn directly rather than using spawnBrainViaMechRun from
  // round-table.ts, which would call buildParticipantPrompt() and replace our
  // player/coach framing with round-table discussion framing.
  const mechRunBin = join(DEV_DIR, 'mech', 'mech-run', 'bin', 'mech-run');
  if (existsSync(mechRunBin)) {
    try {
      const { CLAUDE_CODE_SESSION_ID: _dropMrSessionId, ...inheritedEnvMR } = process.env as Record<string, string>;
      const spawnEnvMR: Record<string, string> = {
        ...inheritedEnvMR,
        HOME: process.env.HOME || homedir(),
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        TERM: process.env.TERM ?? 'xterm-256color',
      };

      // Build spawn arguments with optional model
      const spawnArgs: string[] = [
        process.execPath, mechRunBin, 'spawn', '-p', prompt, '--project', repoPath,
        '--timeout', String(SPAWN_TIMEOUT_MS), '--auto-approve', '--provider', provider,
      ];
      if (model) {
        spawnArgs.push('--model', model);
      }

      const mechProc = Bun.spawn(spawnArgs,
        { cwd: join(DEV_DIR, 'mech', 'mech-run'), env: spawnEnvMR, stdout: 'pipe', stderr: 'pipe' },
      );
      const mechTimer = setTimeout(() => { try { mechProc.kill(); } catch {} }, SPAWN_TIMEOUT_MS + 5000);
      const mechExit = await mechProc.exited;
      clearTimeout(mechTimer);
      if (mechExit === 0) {
        const mechOut = (await new Response(mechProc.stdout).text()).trim();
        if (mechOut.length >= 20) {
          console.log(`  [ok] ${agentId} — ${mechOut.length} chars (mech-run:${provider}${modelInfo})`);
          return mechOut;
        }
      }
    } catch {
      console.warn(`  [warn] mech-run failed for ${agentId}, using claude fallback`);
    }
  }

  // Claude binary fallback
  const claudeBin = findClaude();
  // Inherit full parent env so claude can find auth credentials (CLAUDE_CODE_EXECPATH,
  // USER, LANG etc). Strip CLAUDE_CODE_SESSION_ID to avoid session ID collision with
  // the parent claude process.
  const { CLAUDE_CODE_SESSION_ID: _dropSessionId, ...inheritedEnv } = process.env as Record<string, string>;
  const spawnEnv: Record<string, string> = {
    ...inheritedEnv,
    HOME: process.env.HOME || homedir(),
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    TERM: process.env.TERM ?? 'xterm-256color',
  };

  // SECURITY: dontAsk grants the spawned brain unrestricted tool access in repoPath.
  // Intentional — topic files are authored by decisive (the orchestrator) and
  // brains operate within their own known repos. If topic files ever come from
  // untrusted sources, replace with an explicit tool allowlist.
  // NOTE: The coach prompt includes playerOutput (LLM-generated). A prompt injection
  // in playerOutput could target the coach's tool use. Acceptable here since both
  // player and coach are trusted, operator-controlled agents.
  // NOTE: session.brief may be rewritten by the `redirect` command (free-form human input)
  // and is embedded in the player prompt. Trust assumption: the human director is the
  // same trusted operator who launched the session.
  const proc = Bun.spawn([
    claudeBin, '-p', prompt,
    '--output-format', 'json',
    '--max-turns', '20',
    '--permission-mode', 'dontAsk',
  ], { cwd: repoPath, env: spawnEnv, stdout: 'pipe', stderr: 'pipe' });

  const timer = setTimeout(() => { try { proc.kill(); } catch {} }, SPAWN_TIMEOUT_MS);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  const raw = await new Response(proc.stdout).text();
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`${agentId} exited ${exitCode}: ${err.slice(-300)}`);
  }

  // claude --output-format json wraps in { result: "..." }
  try {
    const parsed = JSON.parse(raw);
    const text = parsed.result ?? parsed.content ?? raw;
    console.log(`  [ok] ${agentId} — ${text.length} chars (claude fallback)`);
    return text;
  } catch {
    return raw.trim();
  }
}

// ─── AgentDrive Save ─────────────────────────────────────────────────────────

function loadAgentDriveCreds(): { api_key: string; workspace_id: string } {
  // Env vars take precedence over files (matches brain/tools/agentdrive.ts)
  if (process.env.AGENTDRIVE_API_KEY && process.env.AGENTDRIVE_WORKSPACE_ID) {
    return { api_key: process.env.AGENTDRIVE_API_KEY, workspace_id: process.env.AGENTDRIVE_WORKSPACE_ID };
  }
  const paths = [
    join(homedir(), '.brain', 'agentdrive.json'),
    join(homedir(), '.claude', 'brain-inbox', 'agentdrive.json'),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      let c: Record<string, string>;
      try {
        c = JSON.parse(readFileSync(p, 'utf-8'));
      } catch {
        throw new Error(`AgentDrive credentials file is malformed JSON: ${p}`);
      }
      if (c.api_key && c.workspace_id) return c as { api_key: string; workspace_id: string };
    }
  }
  throw new Error('No AgentDrive credentials found. Create ~/.brain/agentdrive.json');
}

async function saveToAgentDrive(
  session: CollabSession,
  iteration: Iteration,
  artifactName: string,
): Promise<string> {
  const creds = loadAgentDriveCreds();
  const content = [
    `# ${session.topic}`,
    `**Session**: ${session.id}`,
    `**Round**: ${iteration.round}`,
    `**Coach quality**: ${iteration.coach_quality ?? 'n/a'}/10`,
    `**Player**: ${session.player} | **Coach**: ${session.coach}`,
    '',
    resolveFileRef(iteration.player_output),
  ].join('\n');

  const res = await fetch(`${AGENTDRIVE_BASE}/v1/artifacts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${creds.api_key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      workspaceId: creds.workspace_id,
      type: 'document',
      content,
      metadata: { title: artifactName, tags: ['collab', 'approved', session.topic] },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`AgentDrive save failed (${res.status}): ${err}`);
  }

  const data = await res.json() as { id?: string; artifact?: { id: string } };
  const artifactId = data.id ?? (data.artifact as { id: string } | undefined)?.id;
  if (!artifactId) throw new Error(`AgentDrive response missing id: ${JSON.stringify(data)}`);

  // Append to portfolio-changelog
  try {
    const changelogRes = await fetch(`${AGENTDRIVE_BASE}/v1/artifacts?workspace=${creds.workspace_id}&q=portfolio-changelog`, {
      headers: { Authorization: `Bearer ${creds.api_key}` },
    });
    if (changelogRes.ok) {
      const list = await changelogRes.json() as { artifacts?: Array<{ id: string }> };
      const changelogId = list.artifacts?.[0]?.id;
      if (changelogId) {
        const entry = JSON.stringify({
          type: 'collab_approved',
          brain: 'decisive',
          summary: `Approved ${session.topic} — round ${iteration.round}, quality ${iteration.coach_quality}/10`,
          topic: session.topic,
          player: session.player,
          coach: session.coach,
          round: iteration.round,
          quality: iteration.coach_quality,
          ref: artifactId,
          timestamp: new Date().toISOString(),
        });
        await fetch(`${AGENTDRIVE_BASE}/v1/artifacts/${changelogId}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${creds.api_key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: `\n${entry}`, mode: 'append' }),
        });
      }
    }
  } catch {
    // Non-fatal — changelog append is best-effort
  }

  return artifactId;
}

// ─── brain.db Resume Context ─────────────────────────────────────────────────

async function fetchBrainDbContext(topic: string, since: string): Promise<string | null> {
  const brainSearchScript = join(import.meta.dir, 'lib', 'collab-session', 'brain-search.ts');
  if (!existsSync(brainSearchScript)) return null;

  // Check brain.db staleness
  const brainDb = join(import.meta.dir, '..', '.brain', 'brain.db');
  if (!existsSync(brainDb)) {
    console.warn('  [warn] brain.db not found — resume context will be shallow (state file only)');
    console.warn('  Run: agentbootup brain restore (Phase 3) to enable transcript search');
    return null;
  }

  const dbStat = statSync(brainDb);
  const hoursSinceIndex = (Date.now() - dbStat.mtimeMs) / (1000 * 60 * 60);
  if (hoursSinceIndex > BRAIN_DB_STALE_HOURS) {
    console.warn(`  [warn] brain.db last indexed ${Math.round(hoursSinceIndex)}h ago (>${BRAIN_DB_STALE_HOURS}h stale)`);
    console.warn('  Run: agentbootup brain index-transcripts to refresh');
  }

  try {
    const proc = Bun.spawn(
      [process.execPath, brainSearchScript, topic, '--since', since, '--limit', '10'],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    await proc.exited;
    const out = await new Response(proc.stdout).text();
    return out.trim() || null;
  } catch {
    return null;
  }
}

// ─── Readline Helper ─────────────────────────────────────────────────────────

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ─── Display Helpers ─────────────────────────────────────────────────────────

const BOX_WIDTH = 64;
function box(title: string, ...lines: string[]): void {
  const bar = '━'.repeat(BOX_WIDTH);
  console.log(`\n${bar}`);
  console.log(title);
  console.log(bar);
  for (const line of lines) console.log(line);
}

// ─── Director Phase ──────────────────────────────────────────────────────────

type DirectorIntent = { action: 'continue' | 'stop' };

/**
 * Director phase — prompts for human decision after each coach verdict.
 * Returns { action: 'continue' } when the session should run another round,
 * or { action: 'stop' } when the session is paused/closed/approved.
 *
 * Does NOT call runRound — that coupling caused mutual recursion. The outer
 * runSessionLoop holds the iteration cycle.
 */
async function directorLoop(session: CollabSession, dryRun = false): Promise<DirectorIntent> {
  const iteration = session.iterations[session.iterations.length - 1];
  if (!iteration) return { action: 'stop' };

  const verdictLabel = iteration.coach_verdict ?? 'PENDING';
  const qualityLabel = iteration.coach_quality ? ` (quality: ${iteration.coach_quality}/10)` : '';

  box(
    `Round ${iteration.round} — Coach Verdict: ${verdictLabel}${qualityLabel}`,
    '',
    iteration.coach_verdict === 'BLOCK'
      ? '⚠️  BLOCK — this output should not proceed without significant rework.\n'
      : '',
    iteration.coach_feedback || '(no feedback)',
    '',
  );

  if (dryRun) {
    console.log('[dry-run] Director phase — would prompt for action');
    return { action: 'stop' };
  }

  // while loop — no recursion on invalid input
  while (true) {
    console.log('Director options:');
    console.log('  approve   — accept output, save to AgentDrive, continue');
    console.log('  revise    — send back to player with instruction');
    console.log('  redirect  — rewrite the brief entirely');
    console.log('  pause     — save state and exit');
    console.log('  close     — archive session');
    console.log('');

    const action = (await prompt('> ')).toLowerCase().trim();

    if (action === 'approve') {
      const defaultName = session.topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
      const artifactName = await prompt(`Artifact name [${defaultName}]: `) || defaultName;

      console.log('  Saving to AgentDrive...');
      let artifactId: string;
      try {
        artifactId = await saveToAgentDrive(session, iteration, artifactName);
      } catch (err) {
        console.error(`  ✗ AgentDrive save failed: ${err instanceof Error ? err.message : String(err)}`);
        console.error('  Session state unchanged — try approve again or pause to retry later.');
        continue; // back to Director prompt, don't change state
      }
      iteration.artifact_id = artifactId;
      // Single save directly to OPEN — avoids crash window where session file
      // persists as APPROVED (which resume treats as done rather than prompting director)
      session.state = 'OPEN';
      saveSession(session, 'DIRECTOR');

      console.log(`  ✓ Saved: ${artifactId}`);
      console.log(`  Artifact: ${artifactName}`);
      console.log('\n  Session stays OPEN. Start next round with:');
      console.log(`    bun scripts/collab-session.ts resume ${session.id}`);
      return { action: 'stop' };

    } else if (action === 'revise') {
      const instruction = await prompt('Instruction for player: ');
      iteration.director_instruction = instruction;
      session.round += 1;
      session.state = 'PLAYER_TURN';
      saveSession(session, 'DIRECTOR');
      console.log('\n  Running next round...\n');
      return { action: 'continue' };

    } else if (action === 'redirect') {
      console.log('Enter new brief (end with a line containing only "---"):');
      const lines: string[] = [];
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      await new Promise<void>(resolve => {
        rl.on('line', line => {
          if (line === '---') { rl.close(); resolve(); }
          else lines.push(line);
        });
      });
      if (!lines.length) {
        console.warn('  Brief cannot be empty — try again.\n');
        continue;
      }
      session.brief = lines.join('\n');
      // Use monotonic round++ on redirect — preserves iteration history without
      // numbering conflicts (resetting to 1 would conflict with prior iterations)
      session.round += 1;
      session.state = 'PLAYER_TURN';
      saveSession(session, 'DIRECTOR');
      console.log('\n  Brief updated. Running new round...\n');
      return { action: 'continue' };

    } else if (action === 'pause') {
      session.state = 'PAUSED';
      saveSession(session, 'DIRECTOR');
      console.log(`\n  Session paused. Resume with:`);
      console.log(`    bun scripts/collab-session.ts resume ${session.id}`);
      return { action: 'stop' };

    } else if (action === 'close') {
      session.state = 'CLOSED';
      saveSession(session, 'DIRECTOR');
      console.log(`\n  Session closed: ${session.id}`);
      return { action: 'stop' };

    } else {
      console.log(`  Unknown action: "${action}". Try: approve / revise / redirect / pause / close\n`);
      // loop continues — no recursion, no stack growth
    }
  }
}

// ─── Round Runner ─────────────────────────────────────────────────────────────

async function runRound(session: CollabSession, dryRun = false): Promise<void> {
  // Extract provider/model from session defaults
  const provider = session.defaults?.provider ?? 'claude-code';
  const model = session.defaults?.model;

  // Player turn
  const prevState = session.state;
  session.state = 'PLAYER_TURN';
  saveSession(session, prevState);

  if (session.round > 10) {
    console.warn(`  [warn] Round ${session.round} — session has been running a long time. Consider redirecting or closing.`);
  }
  console.log(`\n[Round ${session.round}] Player turn: ${session.player}...`);

  // Idempotent recovery: if player output already on disk from a previous (interrupted) run, reuse it
  const playerFile = playerFilePath(session.id, session.round);
  let playerOutput: string;
  let playerRecovered = false;
  if (existsSync(playerFile)) {
    console.log(`  [recover] reusing existing ${PLAYER_MD} for round ${session.round}`);
    playerOutput = readFileSync(playerFile, 'utf-8');
    playerRecovered = true;
  } else {
    const playerPrompt = buildPlayerPrompt(session);
    playerOutput = await runBrainWithPrompt(session.player, playerPrompt, dryRun, provider, model);
  }

  // Save to round file for auditability; explicitly skip write when recovering so the
  // existing file is not overwritten (structural guard, not reliant on empty-string convention)
  let playerPath: string;
  if (playerRecovered) {
    playerPath = playerFilePath(session.id, session.round);
  } else {
    ({ playerPath } = saveRoundFiles(session.id, session.round, playerOutput, ''));
  }
  const playerOutputRef = Buffer.byteLength(playerOutput, 'utf-8') > FILE_THRESHOLD_BYTES
    ? `file:${playerPath}`
    : playerOutput;

  // Record iteration
  const iteration: Iteration = {
    round: session.round,
    player_output: playerOutputRef,
    coach_verdict: null,
    coach_feedback: '',
    coach_quality: null,
    director_instruction: null,
    artifact_id: null,
    timestamp: new Date().toISOString(),
  };
  session.iterations.push(iteration);

  // Coach turn
  session.state = 'COACH_TURN';
  saveSession(session, 'PLAYER_TURN');

  console.log(`\n[Round ${session.round}] Coach turn: ${session.coach} (${session.coachType})...`);

  let verdict: CoachVerdict;
  let feedback: string;
  let quality: number | null = null;

  // Idempotent recovery: if coach output already on disk from a previous (interrupted) run, reuse it
  const coachFile = coachFilePath(session.id, session.round);
  let coachRecovered = false;
  if (existsSync(coachFile)) {
    console.log(`  [recover] reusing existing ${COACH_MD} for round ${session.round}`);
    const cached = parseCoachVerdict(readFileSync(coachFile, 'utf-8'));
    verdict = cached.verdict;
    feedback = cached.feedback;
    quality = cached.quality;
    coachRecovered = true;
  } else if (session.coachType === 'script') {
    const result = await runScriptCoach(session.coach, playerOutput, SPAWN_TIMEOUT_MS);
    verdict = result.verdict;
    feedback = result.feedback;
  } else {
    const coachPrompt = buildCoachPrompt(session, playerOutput);
    const coachOutput = await runBrainWithPrompt(session.coach, coachPrompt, dryRun, provider, model);
    ({ verdict, feedback, quality } = parseCoachVerdict(coachOutput));
  }

  // Save to round file for auditability; skip write when recovering (symmetric with player pattern)
  let coachPath: string;
  if (coachRecovered) {
    coachPath = coachFilePath(session.id, session.round);
  } else {
    ({ coachPath } = saveRoundFiles(session.id, session.round, '', feedback));
  }
  const coachFeedbackRef = Buffer.byteLength(feedback, 'utf-8') > FILE_THRESHOLD_BYTES
    ? `file:${coachPath}`
    : feedback;

  iteration.coach_verdict = verdict;
  iteration.coach_feedback = coachFeedbackRef;
  iteration.coach_quality = quality;

  session.state = 'DIRECTOR';
  saveSession(session, 'COACH_TURN');
  // directorLoop is called by the outer session loop — not called here
}

const isTerminalState = (s: SessionState): boolean =>
  s === 'PAUSED' || s === 'CLOSED' || s === 'COMPLETE' || s === 'STALLED';

/**
 * Autonomous loop — runs rounds without human gates until COMPLETE, STALLED, or error.
 * APPROVE  → COMPLETE and stop.
 * REVISE + rounds remaining → append coach feedback to brief, increment round, continue.
 * REVISE + at limit → STALLED.
 * BLOCK    → STALLED.
 * Error    → STALLED; last iteration gets error message as coach_feedback.
 */
export async function runAutonomousLoop(session: CollabSession, dryRun = false): Promise<void> {
  while (!isTerminalState(session.state)) {
    const stateBeforeRound = session.state;
    try {
      await runRound(session, dryRun);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`\n[autonomous] round error: ${errMsg}`);
      if (session.iterations.length > 0) {
        session.iterations[session.iterations.length - 1].coach_feedback = errMsg;
      }
      session.state = 'STALLED';
      saveSession(session, stateBeforeRound);
      await sendNotification(session);
      break;
    }

    // runRound normally leaves session in DIRECTOR, but an in-flight interrupt (e.g. PAUSED)
    // can produce a terminal state — guard before routing on verdict.
    if (isTerminalState(session.state)) break;

    const lastIteration = session.iterations[session.iterations.length - 1];
    const verdict = lastIteration?.coach_verdict;

    if (verdict === 'APPROVE') {
      session.state = 'COMPLETE';
      saveSession(session, 'DIRECTOR');
      await sendNotification(session);
      console.log(`\n[autonomous] COMPLETE after round ${session.round}.`);
      break;

    } else if (verdict === 'REVISE' && session.round < session.max_rounds) {
      const feedback = lastIteration.coach_feedback ? resolveFileRef(lastIteration.coach_feedback) : '';
      const addendum = `\n\n--- Coach feedback (round ${session.round}) ---\n${feedback}`;
      // Cap before append: if accumulated brief would overflow, drop oldest context (keep tail).
      // Newest rounds are most relevant; keep the tail so recent feedback survives truncation.
      // When addendum alone exceeds BRIEF_MAX (pathological), keep only the last BRIEF_MAX chars.
      // Note: the addendum > BRIEF_MAX path is not unit-tested (requires >50k coach output).
      if (session.brief.length + addendum.length > BRIEF_MAX) {
        console.warn(`  [warn] session.brief at ${session.brief.length} chars — dropping oldest context to fit ${BRIEF_MAX} cap`);
        const space = BRIEF_MAX - addendum.length;
        session.brief = space > 0 ? session.brief.slice(-space) + addendum : addendum.slice(-BRIEF_MAX);
      } else {
        session.brief += addendum;
      }
      session.round += 1;
      session.state = 'PLAYER_TURN';
      saveSession(session, 'DIRECTOR');
      // no notification on intermediate REVISE — only terminal states notify
      console.log(`\n[autonomous] REVISE — continuing to round ${session.round} (max ${session.max_rounds}).`);

    } else if (verdict === 'REVISE' && session.round >= session.max_rounds) {
      session.state = 'STALLED';
      saveSession(session, 'DIRECTOR');
      await sendNotification(session);
      console.log(`\n[autonomous] STALLED — max rounds (${session.max_rounds}) reached.`);
      break;

    } else {
      // BLOCK or unexpected verdict
      session.state = 'STALLED';
      saveSession(session, 'DIRECTOR');
      await sendNotification(session);
      console.log(`\n[autonomous] STALLED — coach verdict: ${verdict ?? 'null'}.`);
      break;
    }
  }
}

/**
 * Outer session loop — holds the iteration cycle so runRound and directorLoop
 * are never mutually recursive. Each call to runRound + directorLoop is one
 * flat stack frame; the loop handles continuation.
 */
async function runSessionLoop(session: CollabSession, dryRun = false): Promise<void> {
  if (session.mode === 'autonomous') {
    await runAutonomousLoop(session, dryRun);
    return;
  }

  while (!isTerminalState(session.state)) {
    if (session.state === 'OPEN' || session.state === 'PLAYER_TURN' || session.state === 'COACH_TURN') {
      await runRound(session, dryRun);
    }

    if (session.state === 'DIRECTOR') {
      const intent = await directorLoop(session, dryRun);
      if (intent.action === 'stop') break;
      // intent.action === 'continue' → loop continues, runRound picks up next round
    } else {
      // PAUSED / CLOSED / APPROVED / COMPLETE / STALLED → exit
      break;
    }
  }
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdStart(
  topicFilePath: string,
  dryRun = false,
  overrides?: { mode?: 'director' | 'autonomous'; max_rounds?: number },
): Promise<void> {
  const tf = parseTopicFile(topicFilePath);
  const session = createSession(tf, overrides);

  const provider = session.defaults?.provider ?? 'claude-code';
  const modelInfo = session.defaults?.model ? ` (${session.defaults.model})` : '';

  box(
    `Collab Session Started: ${session.id}`,
    `Topic:    ${session.topic}`,
    `Player:   ${session.player}`,
    `Coach:    ${session.coach}  (${session.coachType})`,
    `Mode:     [${session.mode}]${session.mode === 'autonomous' ? `  max_rounds: ${session.max_rounds}` : ''}`,
    `Provider: ${provider}${modelInfo}`,
    dryRun ? '\n[DRY RUN — no brains will be spawned]' : '',
  );

  session.round = 1;
  saveSession(session);

  await runSessionLoop(session, dryRun);
}

async function cmdResume(id: string): Promise<void> {
  const session = loadSession(id);

  box(
    `Resuming Session: ${session.id}`,
    `Topic:   ${session.topic}`,
    `Mode:    [${session.mode ?? 'director'}]`,
    `State:   ${session.state}`,
    `Round:   ${session.round}`,
    `Player:  ${session.player}`,
    `Coach:   ${session.coach}  (${session.coachType ?? 'brain'})`,
    `Created: ${session.created_at}`,
  );

  // Two-layer resume: brain.db context
  console.log('\nSearching transcript history for context...');
  const brainContext = await fetchBrainDbContext(session.topic, session.created_at);
  if (brainContext) {
    console.log('\n── Transcript context ──');
    console.log(brainContext.slice(0, 800));
    if (brainContext.length > 800) console.log('... (truncated)');
    console.log('───────────────────────');
  }

  // Re-enter correct phase
  switch (session.state) {
    case 'OPEN':
      if (session.round === 0) {
        session.round = 1;
        saveSession(session);
      }
      await runSessionLoop(session);
      break;
    case 'PLAYER_TURN':
      await runSessionLoop(session);
      break;
    case 'COACH_TURN': {
      // Player output exists — re-run coach then enter session loop
      const lastIteration = session.iterations[session.iterations.length - 1];
      if (!lastIteration) { session.state = 'PLAYER_TURN'; await runSessionLoop(session); break; }
      // Idempotency: if recovery already persisted a coach result, skip re-running.
      if (lastIteration.coach_verdict !== undefined && lastIteration.coach_verdict !== null) {
        session.state = 'DIRECTOR';
        saveSession(session, 'COACH_TURN');
        await runSessionLoop(session);
        break;
      }
      // Resolve file: reference so coach gets the full player output, not a path string
      const playerOutputResolved = resolveFileRef(lastIteration.player_output);
      console.log(`\nRe-spawning coach: ${session.coach} (${session.coachType})...`);
      // INVARIANT: from === to — saveSession deduplicates same-state transitions;
      // call appendEvent directly to force this re-entry marker. Do not route through saveSession.
      appendEvent(session.id, 'COACH_TURN', 'COACH_TURN'); // re-entry marker (not a state transition)
      if (session.coachType === 'script') {
        const result = await runScriptCoach(session.coach, playerOutputResolved, SPAWN_TIMEOUT_MS);
        // '' player arg: saveRoundFiles skips empty writes — existing player.md is preserved
        const { coachPath } = saveRoundFiles(session.id, session.round, '', result.feedback);
        lastIteration.coach_verdict = result.verdict;
        lastIteration.coach_feedback = Buffer.byteLength(result.feedback, 'utf-8') > FILE_THRESHOLD_BYTES
          ? `file:${coachPath}`
          : result.feedback;
        lastIteration.coach_quality = null;
      } else {
        const provider = session.defaults?.provider ?? 'claude-code';
        const model = session.defaults?.model;
        const coachPrompt = buildCoachPrompt(session, playerOutputResolved);
        const coachOutput = await runBrainWithPrompt(session.coach, coachPrompt, false, provider, model);
        const { verdict, feedback, quality } = parseCoachVerdict(coachOutput);
        // '' player arg: saveRoundFiles skips empty writes — existing player.md is preserved
        const { coachPath } = saveRoundFiles(session.id, session.round, '', feedback);
        lastIteration.coach_verdict = verdict;
        lastIteration.coach_feedback = Buffer.byteLength(feedback, 'utf-8') > FILE_THRESHOLD_BYTES
          ? `file:${coachPath}`
          : feedback;
        lastIteration.coach_quality = quality;
      }
      session.state = 'DIRECTOR';
      saveSession(session, 'COACH_TURN');
      await runSessionLoop(session);
      break;
    }
    case 'DIRECTOR':
      await runSessionLoop(session);
      break;
    case 'PAUSED':
    case 'STALLED': {
      // Both PAUSED and STALLED re-enter at DIRECTOR so the human can redirect or close.
      const stalledPrev = session.state;
      session.state = 'DIRECTOR';
      saveSession(session, stalledPrev);
      await runSessionLoop(session);
      break;
    }
    case 'APPROVED':
      // APPROVED is never written to the session file — on approve, directorLoop saves
      // directly as OPEN (single save, no crash window). This case only exists as a
      // forward-compat guard if the state type is ever extended or a file is hand-edited.
      // Treat it as OPEN: re-enter the session loop.
      session.state = 'OPEN';
      await runSessionLoop(session);
      break;
    case 'COMPLETE': {
      const lastIt = session.iterations[session.iterations.length - 1];
      box(
        `Session COMPLETE: ${session.id}`,
        `Topic:    ${session.topic}`,
        `Rounds:   ${session.round}`,
        `Brief:    ${(session.original_brief ?? session.brief).slice(0, 120)}`,
        lastIt?.coach_feedback ? `Last coach feedback:\n  ${lastIt.coach_feedback.slice(0, 200)}` : '',
        session.last_approved_artifact_id ? `Artifact: ${session.last_approved_artifact_id}` : '',
      );
      break;
    }
    case 'CLOSED':
      console.log('Session is CLOSED. Use `log` to view history.');
      break;
  }
}

function cmdList(): void {
  const sessions = listSessions();
  if (sessions.length === 0) {
    console.log('No sessions found. Start one with:');
    console.log('  bun scripts/collab-session.ts start <topic-file.md>');
    return;
  }

  const pad = (s: string, n: number) => s.slice(0, n).padEnd(n);
  console.log(`\n${'─'.repeat(90)}`);
  console.log(`${pad('ID', 18)} ${pad('STATE', 12)} ${pad('RND', 4)} ${pad('PLAYER', 18)} ${pad('TOPIC', 36)}`);
  console.log('─'.repeat(90));
  for (const s of sessions) {
    const age = Math.round((Date.now() - new Date(s.last_active).getTime()) / (1000 * 60));
    const ageLabel = age < 60 ? `${age}m` : `${Math.round(age / 60)}h`;
    console.log(
      `${pad(s.id, 18)} ${pad(s.state, 12)} ${String(s.round).padStart(3)}  ${pad(s.player, 18)} ${pad(s.topic, 30)} ${ageLabel}`
    );
  }
  console.log('─'.repeat(90));
}

function cmdLog(id: string): void {
  const session = loadSession(id);
  box(
    `Session Log: ${session.id}`,
    `Topic:  ${session.topic}`,
    `State:  ${session.state}`,
    `Rounds: ${session.iterations.length}`,
  );
  if (session.iterations.length === 0) {
    console.log('No iterations yet.');
    return;
  }
  for (const it of session.iterations) {
    console.log(`\n── Round ${it.round} ─────────────────────────────`);
    console.log(`Verdict:   ${it.coach_verdict ?? 'pending'}`);
    if (it.coach_quality) console.log(`Quality:   ${it.coach_quality}/10`);
    if (it.artifact_id) console.log(`Artifact:  ${it.artifact_id}`);
    if (it.coach_feedback) {
      const feedbackText = resolveFileRef(it.coach_feedback);
      console.log(`Feedback:\n${feedbackText.slice(0, 400)}${feedbackText.length > 400 ? '...' : ''}`);
    }
    if (it.director_instruction) {
      console.log(`Director:  ${it.director_instruction}`);
    }
    const playerText = resolveFileRef(it.player_output);
    console.log(`Player output (${playerText.length} chars):`);
    console.log(playerText.slice(0, 300) + (playerText.length > 300 ? '...' : ''));
  }
}

function cmdClose(id: string): void {
  const session = loadSession(id);
  const prevState = session.state;
  session.state = 'CLOSED';
  saveSession(session, prevState);
  console.log(`Session closed: ${id}`);
  console.log(`${session.iterations.length} iteration(s) archived. View with:`);
  console.log(`  bun scripts/collab-session.ts log ${id}`);
}

// ─── Test Factory ─────────────────────────────────────────────────────────────
// Exported only for use in session.test.ts. Builds a minimal CollabSession and
// writes it to SESSIONS_DIR so runAutonomousLoop can save state updates.

export function makeTestSession(
  id: string,
  opts: {
    mode?: 'autonomous' | 'director';
    max_rounds?: number;
    coachType?: 'script' | 'brain';
    coach?: string;
    player?: string;
    state?: SessionState;
    round?: number;
    iterations?: Iteration[];
  } = {},
): CollabSession {
  if (!id.startsWith('cs_')) throw new Error(`makeTestSession: id must start with "cs_" — got "${id}"`);
  const session: CollabSession = {
    id,
    topic: 'test topic',
    player: opts.player ?? 'decisive.gm',
    coach: opts.coach ?? 'decisive.gm',
    brief: 'test brief',
    original_brief: 'test brief',
    context_artifacts: [],
    state: opts.state ?? 'PLAYER_TURN',
    round: opts.round ?? 1,
    iterations: opts.iterations ?? [],
    created_at: new Date().toISOString(),
    last_active: new Date().toISOString(),
    mode: opts.mode ?? 'autonomous',
    coachType: opts.coachType ?? 'script',
    max_rounds: opts.max_rounds ?? 5,
    notify: undefined,
    last_approved_artifact_id: null,
    defaults: undefined,
  };
  saveSession(session);
  return session;
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const [cmd, arg1] = args;
  const dryRun = args.includes('--dry-run');

  // Parse --mode and --max-rounds overrides
  const modeIdx = args.indexOf('--mode');
  const modeArg = modeIdx !== -1 ? args[modeIdx + 1] : undefined;
  const cliMode: 'director' | 'autonomous' | undefined =
    modeArg === 'autonomous' ? 'autonomous' : modeArg === 'director' ? 'director' : undefined;
  if (modeArg && !cliMode) console.warn(`[warn] Unknown --mode value: "${modeArg}" — using topic file default`);

  const maxRoundsIdx = args.indexOf('--max-rounds');
  const maxRoundsArg = maxRoundsIdx !== -1 ? args[maxRoundsIdx + 1] : undefined;
  const cliMaxRoundsValid = maxRoundsArg ? /^\d+$/.test(maxRoundsArg) : false;
  const cliMaxRoundsRaw = cliMaxRoundsValid ? parseInt(maxRoundsArg!, 10) : undefined;
  const cliMaxRounds = cliMaxRoundsRaw && cliMaxRoundsRaw > 0 ? cliMaxRoundsRaw : undefined;
  if (maxRoundsArg && !cliMaxRounds) console.warn(`[warn] Invalid --max-rounds value: "${maxRoundsArg}" — using default`);
  const cliOverrides = (cliMode || cliMaxRounds) ? { mode: cliMode, max_rounds: cliMaxRounds } : undefined;

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log('Usage:');
    console.log('  bun scripts/collab-session.ts start <topic-file.md> [--dry-run] [--mode autonomous|director] [--max-rounds N]');
    console.log('  bun scripts/collab-session.ts resume <session-id>');
    console.log('  bun scripts/collab-session.ts list');
    console.log('  bun scripts/collab-session.ts log <session-id>');
    console.log('  bun scripts/collab-session.ts close <session-id>');
    console.log('');
    console.log('Flags:');
    console.log('  --mode autonomous|director   Override topic file mode (default: director)');
    console.log('  --max-rounds N               Override max rounds for autonomous mode (default: 5)');
    console.log('                               Counts total rounds; STALLED when round >= max_rounds after REVISE');
    console.log('  --dry-run                    Simulate without spawning brains');
    console.log('');
    console.log('Legacy entrypoint:');
    console.log('  bun brain/collab-session.ts ...');
    console.log('');
    console.log('Topic file format:');
    console.log('  ---');
    console.log('  topic: "Session topic"');
    console.log('  participants: ["player.gm", "coach.gm"]');
    console.log('  context_artifacts: ["artifact-id-1", "artifact-id-2"]');
    console.log('  mode: director        # director (default) | autonomous');
    console.log('  coachType: brain      # brain (default) | script');
    console.log('  max_rounds: 5         # autonomous mode only — total rounds before STALLED');
    console.log('  notify: decisive-gm   # ADMP agent ID or ./path/to/notify.json on COMPLETE/STALLED');
    console.log('  defaults:');
    console.log('    provider: claude-code    # claude-code | gemini-cli | cursor-cli | codex | opencode');
    console.log('    model: claude-3-5-haiku  # optional provider-specific model');
    console.log('  ---');
    console.log('  ## Brief');
    console.log('  ...');
    process.exit(0);
  }

  switch (cmd) {
    case 'start':
      if (!arg1) { console.error('Usage: start <topic-file.md>'); process.exit(1); }
      await cmdStart(arg1, dryRun, cliOverrides);
      break;
    case 'resume':
      if (!arg1) { console.error('Usage: resume <session-id>'); process.exit(1); }
      await cmdResume(arg1);
      break;
    case 'list':
      cmdList();
      break;
    case 'log':
      if (!arg1) { console.error('Usage: log <session-id>'); process.exit(1); }
      cmdLog(arg1);
      break;
    case 'close':
      if (!arg1) { console.error('Usage: close <session-id>'); process.exit(1); }
      cmdClose(arg1);
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      process.exit(1);
  }
}
