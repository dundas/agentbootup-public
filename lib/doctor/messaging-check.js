/**
 * FR-3 `messaging_round_trips` check (PRD-0038 Task 3/§1).
 *
 * Sends a real prompt through the runtime's chat API (Hermes/OpenClaw
 * `/v1/chat/completions`) and verifies a usable response. This is the AC-4 guard: a
 * runtime that is process-up but chat-dead must surface as `fail` → Degraded (the reducer
 * maps messaging failure to Degraded, not Stuck — the runtime exists, it just can't talk).
 *
 * Fail-closed: the round-trip `chat` is REQUIRED and NON-SKIPPABLE — if absent, the check
 * FAILS (we cannot prove messaging works), never skips to green. An empty/blank reply, a
 * thrown error, or a timeout all → `fail`.
 *
 * `chat` is injectable so the check is exercised mock-first without a live runtime.
 */

const DEFAULT_PROMPT = 'doctor health probe — reply with a single token to confirm the chat API is alive';

function result(state, message) {
  const severity = state === 'pass' ? 'info' : 'error';
  return { state, severity, category: 'messaging', message };
}
function errMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

// Extract the assistant reply text from either a bare string or an object with `content`.
function replyText(reply) {
  if (typeof reply === 'string') return reply;
  if (reply && typeof reply === 'object' && typeof reply.content === 'string') return reply.content;
  return undefined;
}

/**
 * @param {object} input
 * @param {(prompt: string) => Promise<string | {content?: string}>} input.chat
 *        Sends a prompt to the runtime chat API and resolves the assistant reply
 *        (a string, or an object with a `content` field). Injectable; live = POST to
 *        the runtime's /v1/chat/completions.
 * @param {string} [input.prompt]  Prompt to send (default: a minimal liveness probe).
 * @param {(text: string) => boolean} [input.expectReply]
 *        Optional reply validator. When provided, it must return the boolean `true` to
 *        pass — any other value (including truthy non-booleans) is treated as a failure
 *        (fail-closed, consistent with the credentials round-trip). Lets a caller require
 *        a known token and reject an error-text/echo body that would otherwise pass the
 *        default non-empty bar. Default bar = non-empty reply, a LIVENESS signal (the
 *        pipeline produced output), not semantic correctness.
 * @param {number} [input.timeoutMs]  Bound the round-trip (default 15000) — a hung chat
 *        fails closed within this window so the doctor never blocks. Any value ≤0 disables
 *        the timer. NOTE: a
 *        timed-out `chat` promise is left dangling (it is opaque to this check); live
 *        `chat` implementations should also bound/abort their own request (e.g. AbortSignal).
 * @returns {Promise<{state:'pass'|'fail', severity, category:'messaging', message:string}>}
 */
export async function checkMessagingRoundTrip(input = {}) {
  const { chat, prompt = DEFAULT_PROMPT, expectReply, timeoutMs = 15_000 } = input;
  if (typeof chat !== 'function') {
    return result('fail', 'no chat round-trip provided — cannot prove messaging round-trips');
  }

  const TIMED_OUT = Symbol('timed_out');
  let timer;
  let reply;
  try {
    if (timeoutMs > 0) {
      const p = chat(prompt);
      // Attach a no-op catch so a rejection on the promise that LOSES the race (e.g. the
      // chat rejects after the timeout already fired) does not surface as an
      // unhandledRejection. The handled `p` is still what we race + await.
      p.catch(() => {});
      reply = await Promise.race([
        p,
        new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs); }),
      ]);
    } else {
      reply = await chat(prompt);
    }
  } catch (err) {
    // Process-up but chat-dead (connection refused / 5xx) → fail (AC-4). NOTE: messaging is
    // the one non-load-bearing check (the reducer maps its failure to Degraded, never Stuck),
    // so unlike runtime/credentials there is no false-Stuck risk here and no unknown split is
    // needed — a dead chat is reported as a plain fail (→ Degraded).
    return result('fail', `chat round-trip failed: ${errMessage(err)}`);
  } finally {
    clearTimeout(timer);
  }
  if (reply === TIMED_OUT) {
    return result('fail', `chat round-trip timed out after ${timeoutMs}ms (chat hung — dead)`);
  }

  const text = replyText(reply);
  if (typeof text !== 'string' || text.trim().length === 0) {
    return result('fail', 'chat API returned no usable response (empty/blank reply — chat dead)');
  }
  if (typeof expectReply === 'function') {
    let ok;
    try {
      ok = expectReply(text);
    } catch (err) {
      return result('fail', `reply validator threw: ${errMessage(err)}`);
    }
    if (ok !== true) {
      return result('fail', 'chat replied, but the response failed the expected-reply check');
    }
  }
  return result('pass', 'chat API round-trip succeeded (runtime responded)');
}
