#!/usr/bin/env bun
/**
 * lib/daemon/inbox-daemon.mjs
 *
 * Inbox daemon — check-evaluate-spawn loop.
 *
 * Listens on AGENTBOOTUP_INBOX_PORT for webhook POSTs from AgentDispatch hub.
 * On each message: verify signature → evaluate (is this for us?) → spawn if yes.
 *
 * This daemon has no concept of "waking a machine". It assumes the machine is
 * already running. If the machine needs to be woken first, that is handled at
 * the infrastructure level (push notification, wake-on-LAN, etc.) before this
 * daemon is reached. Multiple brains can run their daemons on the same machine —
 * each evaluates independently and ignores traffic not addressed to it.
 *
 * Environment variables (set by `agentbootup daemon start`):
 *   AGENTBOOTUP_BRAIN_ID             — Brain identifier (e.g. "bootup.gm")
 *   AGENTBOOTUP_INBOX_PORT           — Port to listen on (e.g. 8767)
 *   AGENTBOOTUP_INBOX_WEBHOOK_SECRET — HMAC-SHA256 secret for payload verification
 *   AGENTBOOTUP_PROJECT_ROOT         — Project root directory (passed to mech-run)
 *   AGENTBOOTUP_SPAWN_PROVIDER       — mech-run provider (default: claude-code)
 *
 * Protocol:
 *   POST /webhook
 *     Headers: x-agentdispatch-signature: sha256=<hmac-hex>
 *     Body: JSON payload from AgentDispatch
 *   → 200 OK (accepted), 200 Skipped (not for us), 401 invalid sig, 400 bad JSON
 *
 *   GET /health
 *   → 200 { status: "ok", brainId, port }
 *
 * Spawn behaviour:
 *   verify → evaluate (to field matches BRAIN_ID?) → debounce check → mech-run spawn
 *   Debounce window: 60s (prevents burst of messages spawning multiple sessions)
 *   Spawn is fire-and-forget — daemon lifecycle is independent of session lifetime
 */

import crypto from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { reallocateInboxPort } from '../brain/port-registry.js';

// Strip CR/LF from strings before logging to prevent log injection.
const sanitize = (s) => String(s).replace(/[\r\n]/g, ' ');

// Debounce: don't spawn a new session if one was triggered within this window.
const SPAWN_DEBOUNCE_MS = 60_000;
let lastSpawnAt = 0;

const BRAIN_ID = sanitize(process.env.AGENTBOOTUP_BRAIN_ID || 'unknown');
const PORT = parseInt(process.env.AGENTBOOTUP_INBOX_PORT || '8767', 10);
const WEBHOOK_SECRET = process.env.AGENTBOOTUP_INBOX_WEBHOOK_SECRET || '';
const PROJECT_ROOT = process.env.AGENTBOOTUP_PROJECT_ROOT || process.cwd();

if (!WEBHOOK_SECRET) {
  process.stderr.write(
    `[inbox-daemon] WARNING: AGENTBOOTUP_INBOX_WEBHOOK_SECRET is not set. ` +
    `All webhook requests will be rejected. ` +
    `Run 'agentbootup brain restore' to provision the secret.\n`,
  );
}

/**
 * Verify an HMAC-SHA256 signature against the webhook secret.
 * Header format: sha256=<hex>
 *
 * Accepts any single signature header value. The caller is responsible for
 * selecting which header to check (see verifyAnySignatureHeader).
 *
 * @param {string} rawBody
 * @param {string | null} signatureHeader
 * @returns {boolean}
 */
function verifySignature(rawBody, signatureHeader) {
  if (!WEBHOOK_SECRET) return false;
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const provided = signatureHeader.slice('sha256='.length);
  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('hex');
  // Constant-time comparison to prevent timing attacks.
  try {
    return crypto.timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Verify that at least one recognized signature header on the request is valid.
 *
 * Accepted headers (all use sha256=<hex> format):
 *   x-agentdispatch-signature — AgentDispatch / ADMP hub
 *   x-hub-signature-256       — GitHub webhooks and community standard
 *   x-brain-signature         — agentbootup-native / same-machine callers
 *
 * x-brain-signature is preferred over the generic "x-signature" to avoid
 * collisions with proxy or load-balancer headers that use that common name.
 *
 * This allows any sender that knows the brain's webhook secret to trigger a
 * session, not just the ADMP hub — enabling GitHub Actions, Zapier, CI
 * pipelines, and same-machine brain-to-brain calls without special wiring.
 *
 * @param {string} rawBody
 * @param {Request} req
 * @returns {boolean}
 */
function verifyAnySignatureHeader(rawBody, req) {
  const headers = [
    req.headers.get('x-agentdispatch-signature'),
    req.headers.get('x-hub-signature-256'),
    req.headers.get('x-brain-signature'),
  ].filter(Boolean);
  // No signature header present at all.
  if (headers.length === 0) return false;
  // Accept if any provided header verifies — allows callers to use whichever
  // header their framework supports without needing to send multiple.
  // Compute all results up-front to avoid timing side-channels from
  // short-circuit evaluation — all HMACs are computed regardless of outcome.
  const results = headers.map((h) => verifySignature(rawBody, h));
  const accepted = results.some(Boolean);
  // If more than one header was sent and some failed, warn so callers with a
  // broken secondary header don't silently go unnoticed.
  if (accepted && results.length > 1 && !results.every(Boolean)) {
    process.stderr.write(
      `[inbox-daemon] ${BRAIN_ID}: accepted webhook but some signature headers were invalid — ` +
      `check sender configuration\n`,
    );
  }
  return accepted;
}

/**
 * Evaluate whether a payload is addressed to the given brain ID.
 *
 * Exported for unit testing — the module-level isForThisBrain() wraps this
 * with the process BRAIN_ID so production code reads naturally.
 *
 * Checks payload.to (direct) and payload.envelope.to (wrapped format).
 * Group messages addressed to a group this brain belongs to are handled
 * by the brain session itself after spawn — we spawn conservatively on
 * any message that includes our ID anywhere in the to field.
 *
 * Note: when brainId is already ADMP-qualified (contains a dot, e.g. "bootup.gm"),
 * only the exact qualified form is matched — bare form ("bootup") is intentionally
 * rejected. The hub always uses the qualified form in webhook payloads, so this is
 * the correct behavior. Bare-form messages are transport artifacts and should not
 * wake a qualified daemon.
 *
 * @param {object} payload
 * @param {string} brainId
 * @returns {boolean}
 */
export function isForBrain(payload, brainId) {
  const to = payload?.to || payload?.envelope?.to || '';
  if (!to) return true; // no to field — treat as broadcast, spawn
  // Normalize to array of trimmed, non-empty tokens.
  // Split on comma and/or whitespace so both "a,b" and "a b" formats work.
  const recipients = Array.isArray(to)
    ? to.map(String)
    : String(to).split(/[\s,]+/).filter(Boolean);
  // Match both bare ID ("bootup") and ADMP-qualified form ("bootup.gm").
  // The .gm suffix is a network transport detail — the brain has one identity.
  // Only append .gm if brainId doesn't already contain a dot (e.g. already "bootup.gm")
  // to avoid producing "bootup.gm.gm" for a double-qualified ID.
  const qualified = brainId.includes('.') ? brainId : `${brainId}.gm`;
  return recipients.some((r) => r === brainId || r === qualified);
}

function isForThisBrain(payload) {
  return isForBrain(payload, BRAIN_ID);
}

/**
 * Spawn a brain session to process the inbox.
 *
 * Debounced — if a spawn was triggered within SPAWN_DEBOUNCE_MS, skip to
 * avoid launching multiple sessions for a burst of messages.
 *
 * @param {object} payload
 */
function spawnIfNeeded(payload) {
  const from = sanitize(payload?.from || payload?.envelope?.from || 'unknown');
  const subject = sanitize(payload?.subject || payload?.envelope?.subject || payload?.type || 'unknown');

  if (!isForThisBrain(payload)) {
    process.stdout.write(
      `[inbox-daemon] ${BRAIN_ID}: skipped — message not addressed to this brain (from=${from})\n`,
    );
    return false;
  }

  process.stdout.write(
    `[inbox-daemon] ${BRAIN_ID}: message accepted — from=${from} subject=${subject}\n`,
  );

  const now = Date.now();
  if (now - lastSpawnAt < SPAWN_DEBOUNCE_MS) {
    process.stdout.write(
      `[inbox-daemon] ${BRAIN_ID}: debounced — spawn triggered ${Math.round((now - lastSpawnAt) / 1000)}s ago, skipping\n`,
    );
    return true;
  }
  // Capture spawn timestamp locally to guard the debounce reset below.
  const spawnedAt = now;
  lastSpawnAt = spawnedAt;

  process.stdout.write(`[inbox-daemon] ${BRAIN_ID}: spawning session (project: ${PROJECT_ROOT})\n`);

  const provider = process.env.AGENTBOOTUP_SPAWN_PROVIDER || 'claude-code';
  // Array args prevent shell injection — PROJECT_ROOT and provider are never shell-interpolated.
  // stdio:'pipe' keeps stdout/stderr open so we can log mech-run output.
  // detached and unref() are intentionally omitted — with open pipe handles they would
  // be misleading (pipe handles keep the event loop alive regardless). The daemon is
  // long-running; session lifetime does not affect its operation.
  // Concurrent sessions are acceptable — brain inbox processing is idempotent.
  const child = spawn(
    'mech-run',
    ['spawn', '--provider', provider, '--project', PROJECT_ROOT, '--prompt', 'Check your inbox and process all pending messages and work orders. Do not defer or cherry-pick — process everything before concluding the session.'],
    { stdio: 'pipe' },
  );

  child.on('error', (err) => {
    process.stderr.write(`[inbox-daemon] ${BRAIN_ID}: mech-run spawn error (non-fatal): ${err.message}\n`);
    // Reset debounce for *this* spawn only — guard against a race where a concurrent
    // webhook already updated lastSpawnAt to a newer timestamp.
    if (lastSpawnAt === spawnedAt) lastSpawnAt = 0;
  });

  child.stdout.on('data', (d) => {
    process.stdout.write(`[inbox-daemon][mech-run] ${d}`);
  });

  child.stderr.on('data', (d) => {
    process.stderr.write(`[inbox-daemon][mech-run] ${d}`);
  });

  child.on('close', (code) => {
    process.stdout.write(`[inbox-daemon] ${BRAIN_ID}: mech-run exited ${code}\n`);
    // Reset debounce on failure so the next message can retry immediately
    // rather than being locked out for the remainder of the 60s window.
    if (code !== 0 && lastSpawnAt === spawnedAt) lastSpawnAt = 0;
  });

  return true;
}

// ── HTTP server ───────────────────────────────────────────────────────────────

// Startup conflict recovery: verify the assigned port is still bindable before
// the first bind. If an unrelated process claimed it while this daemon was
// stopped, reallocate to a free port and update config so the next `daemon start`
// picks up the corrected assignment without an EADDRINUSE error.
//
// reallocateInboxPort is safe to call here because:
//   1. We are at startup — the daemon is not yet bound, so isPortAvailable returns
//      true for our port if no other process holds it.
//   2. If it returns a different port, the port-registry config is updated on disk
//      so `getInboxPort` and the state file reflect the corrected assignment.
//
// Top-level await is valid in ES modules (.mjs).
let EFFECTIVE_PORT;
try {
  EFFECTIVE_PORT = await reallocateInboxPort(BRAIN_ID);
} catch (err) {
  process.stderr.write(
    `[inbox-daemon] ${BRAIN_ID}: fatal — could not allocate inbox port: ${err.message}\n` +
    `Ensure the inbox port range (8767–8867) has at least one free slot.\n`,
  );
  process.exit(1);
}
// Log any port change — covers two cases:
//   1. Startup conflict: the cached port was claimed by an unrelated process.
//   2. Registry mismatch: daemon started outside `agentbootup daemon start` with
//      no prior registry entry; reallocate scanned for a free port independently
//      of the env-var PORT value.
if (EFFECTIVE_PORT !== PORT) {
  process.stdout.write(
    `[inbox-daemon] ${BRAIN_ID}: port reassigned from ${PORT} to ${EFFECTIVE_PORT} ` +
    `(registry mismatch or startup conflict recovery)\n`,
  );
}

const server = Bun.serve({
  port: EFFECTIVE_PORT,
  hostname: '127.0.0.1',

  async fetch(req) {
    const url = new URL(req.url);

    // Health check — used by agent-process to verify daemon is up.
    if (req.method === 'GET' && url.pathname === '/health') {
      return Response.json({ status: 'ok', brainId: BRAIN_ID, port: EFFECTIVE_PORT });
    }

    // Webhook endpoint — receives push notifications from AgentDispatch.
    if (req.method === 'POST' && url.pathname === '/webhook') {
      // Enforce a 64 KB body cap to prevent memory exhaustion from oversized payloads.
      const MAX_BODY_BYTES = 65_536;
      const contentLength = parseInt(req.headers.get('content-length') || '0', 10);
      if (contentLength > MAX_BODY_BYTES) {
        return new Response('Payload Too Large', { status: 413 });
      }
      const rawBody = await req.text();
      // Use Buffer.byteLength to count UTF-8 bytes, not JS string characters.
      // rawBody.length counts UTF-16 code units; a 65,536-char string of 4-byte
      // codepoints is ~256 KB over the wire — far over the intended 64 KB cap.
      if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
        return new Response('Payload Too Large', { status: 413 });
      }
      if (!verifyAnySignatureHeader(rawBody, req)) {
        process.stderr.write(
          `[inbox-daemon] ${BRAIN_ID}: rejected webhook POST — invalid or missing signature\n`,
        );
        return new Response('Unauthorized', { status: 401 });
      }

      let payload;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return new Response('Bad Request: invalid JSON', { status: 400 });
      }

      // evaluate → spawn if addressed to this brain
      const acted = spawnIfNeeded(payload);
      return new Response(acted ? 'OK' : 'Skipped', { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  },
});

process.stdout.write(
  `[inbox-daemon] ${BRAIN_ID} listening on port ${server.port} ` +
  `(project: ${PROJECT_ROOT})\n`,
);

// ── PID/state file ───────────────────────────────────────────────────────────
// Written on start so `agentbootup doctor` can check daemon health synchronously
// without an HTTP round-trip. Removed on clean exit.

// STATE_DIR is intentionally hardcoded. The AGENTBOOTUP_INBOX_DAEMONS_DIR env
// var in unified-daemon-cli.js redirects the *read* path only (used in tests
// that pre-seed state files without spawning a real daemon subprocess). There
// is no symmetric write-side redirect — inbox-daemon.mjs always writes here
// because it runs as a spawned subprocess outside the test harness process.
const STATE_DIR = path.join(os.homedir(), '.agentbootup', 'inbox-daemons');
// path.basename strips any path separators from BRAIN_ID to prevent traversal
// if AGENTBOOTUP_BRAIN_ID contains "../" sequences.
const STATE_FILE = path.join(STATE_DIR, `${path.basename(BRAIN_ID)}.json`);

try {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({ pid: process.pid, port: server.port, brainId: BRAIN_ID, startedAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
} catch (err) {
  process.stderr.write(`[inbox-daemon] warning: could not write state file: ${err.message}\n`);
}

function removeStateFile() {
  try { fs.unlinkSync(STATE_FILE); } catch { /* ignore */ }
}

process.on('SIGTERM', () => { removeStateFile(); process.exit(0); });
process.on('SIGINT',  () => { removeStateFile(); process.exit(0); });

// Keep alive — agent-process manages the process lifecycle.
