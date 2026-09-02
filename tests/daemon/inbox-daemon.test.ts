/**
 * tests/daemon/inbox-daemon.test.ts
 *
 * Two test suites:
 *
 * 1. Unit tests for isForBrain() routing logic (exported from inbox-daemon.mjs).
 *    Pure function — no server, no network, no env vars needed.
 *
 * 2. HTTP integration tests for the daemon's Bun.serve handler.
 *    Spawns a real inbox-daemon subprocess with isolated config + test credentials,
 *    polls /health until bound, exercises all HTTP paths, then kills the process.
 *    Tests the verifySignature path (not exported) through the HTTP interface.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import crypto from 'crypto';
import { createServer } from 'net';
import type { AddressInfo } from 'net';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
// @ts-ignore — .mjs module, no TS declarations needed
import { isForBrain } from '../../lib/daemon/inbox-daemon.mjs';

// Use Bun.fetch instead of globalThis.fetch to bypass any mock installed by other
// test files (e.g. unified-daemon-cli.test.ts replaces globalThis.fetch at module
// scope).  Bun.fetch is the real native HTTP client and is not replaceable.
const nativeFetch: typeof fetch = Bun.fetch as unknown as typeof fetch;

describe('isForBrain — bare brain ID ("bootup")', () => {
  const brainId = 'bootup';

  test('no to field → true (broadcast)', () => {
    expect(isForBrain({}, brainId)).toBe(true);
    expect(isForBrain({ other: 'field' }, brainId)).toBe(true);
  });

  test('empty to string → true (broadcast)', () => {
    expect(isForBrain({ to: '' }, brainId)).toBe(true);
  });

  test('exact match bare ID → true', () => {
    expect(isForBrain({ to: 'bootup' }, brainId)).toBe(true);
  });

  test('exact match qualified ID → true', () => {
    expect(isForBrain({ to: 'bootup.gm' }, brainId)).toBe(true);
  });

  test('different brain → false', () => {
    expect(isForBrain({ to: 'decisive' }, brainId)).toBe(false);
    expect(isForBrain({ to: 'decisive.gm' }, brainId)).toBe(false);
  });

  test('substring that was a false positive before exact-match fix → false', () => {
    // "bootup" must not match inside "notbootup" or "bootup-extra"
    expect(isForBrain({ to: 'notbootup' }, brainId)).toBe(false);
    expect(isForBrain({ to: 'bootup-extra' }, brainId)).toBe(false);
    expect(isForBrain({ to: 'mybootup.gm' }, brainId)).toBe(false);
  });

  test('comma-separated list containing brain ID → true', () => {
    expect(isForBrain({ to: 'decisive,bootup,clearauth' }, brainId)).toBe(true);
    expect(isForBrain({ to: 'decisive.gm,bootup.gm' }, brainId)).toBe(true);
  });

  test('comma-separated list NOT containing brain ID → false', () => {
    expect(isForBrain({ to: 'decisive,clearauth,helloconvo' }, brainId)).toBe(false);
  });

  test('whitespace-separated list containing brain ID → true', () => {
    expect(isForBrain({ to: 'decisive bootup clearauth' }, brainId)).toBe(true);
  });

  test('array to field → true when matching', () => {
    expect(isForBrain({ to: ['decisive', 'bootup'] }, brainId)).toBe(true);
    expect(isForBrain({ to: ['bootup.gm'] }, brainId)).toBe(true);
  });

  test('array to field → false when not matching', () => {
    expect(isForBrain({ to: ['decisive', 'clearauth'] }, brainId)).toBe(false);
  });

  test('envelope.to field is checked when to is absent', () => {
    expect(isForBrain({ envelope: { to: 'bootup' } }, brainId)).toBe(true);
    expect(isForBrain({ envelope: { to: 'decisive' } }, brainId)).toBe(false);
  });
});

describe('isForBrain — already-qualified brain ID ("bootup.gm")', () => {
  const brainId = 'bootup.gm';

  test('does not produce double-qualified "bootup.gm.gm"', () => {
    // When brainId already contains a dot, qualified === brainId
    // so only one form is matched — not the non-existent "bootup.gm.gm"
    expect(isForBrain({ to: 'bootup.gm.gm' }, brainId)).toBe(false);
  });

  test('exact match still works', () => {
    expect(isForBrain({ to: 'bootup.gm' }, brainId)).toBe(true);
  });

  test('bare form does not match when BRAIN_ID is already qualified', () => {
    // "bootup" is not matched when brainId is "bootup.gm" — the hub always
    // sends the qualified form in webhook payloads, so bare-form messages are
    // transport artifacts that should not wake a qualified daemon.
    expect(isForBrain({ to: 'bootup' }, brainId)).toBe(false);
  });
});

describe('isForBrain — group addresses', () => {
  const brainId = 'bootup';

  test('group address not matching brain ID → false (session handles group membership)', () => {
    expect(isForBrain({ to: 'group://mech-services-communication-bd14b3cd' }, brainId)).toBe(false);
  });

  test('mixed recipients: group + brain ID → true', () => {
    expect(isForBrain({ to: 'group://some-group,bootup' }, brainId)).toBe(true);
  });
});

// ── HTTP integration tests ────────────────────────────────────────────────────
//
// Spawns a real inbox-daemon subprocess with:
//   - An isolated config file + tmpDir (avoids touching ~/.agentbootup/config.json)
//   - A unique brainId per run (avoids collisions with running brains)
//   - A test HMAC secret (64 hex chars)
//   - A hint port chosen dynamically by the OS (bind to :0, release, use that port)
//     Pre-populated in the isolated config as the preferred inbox port.
//
// The daemon calls reallocateInboxPort() at module load using the isolated config.
// It may bind to a different port if the hint port is taken by the time it starts
// (startup conflict recovery).  readDaemonPort() reads the actual bound port from
// the daemon's stdout — "listening on port <N>" — so daemonPort is always correct.

const TEST_SECRET = 'a'.repeat(64);
// Unique brainId per test run — avoids collisions with real running daemons
// and prevents stale state files from interfering.
const TEST_BRAIN_ID = `inbox-http-test-${process.pid}.gm`;

/** Ask the OS for a free port by binding to :0, then release it immediately. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** Sign a raw body string with the test secret. */
function sign(body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', TEST_SECRET).update(body, 'utf8').digest('hex');
}

/**
 * Accumulate a piped stream in the background. `settled` resolves when the stream
 * closes — a diagnostic that reads the buffer before then races the producer and
 * reports an empty stderr, which is the very failure this helper exists to avoid.
 */
function drain(stream: ReadableStream<Uint8Array>): { text: () => string; settled: Promise<void> } {
  const decoder = new TextDecoder();
  let buf = '';
  const settled = (async () => {
    try {
      for await (const chunk of stream as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
      }
    } catch {
      // The stream is torn down when the process is killed; nothing to report.
    }
  })();
  return { text: () => buf, settled };
}

/**
 * Read the daemon's stdout until it emits "listening on port <N>", then return N.
 * More robust than polling /health because the daemon may reallocate to a
 * different port than the one we pre-populated in the config (startup conflict
 * recovery), so we cannot know the final port until the daemon announces it.
 */
async function readDaemonPort(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs = 8_000,
): Promise<number> {
  const decoder = new TextDecoder();
  let buf = '';

  // The daemon writes the reason it could not start to stderr. Reporting only
  // stdout turns every startup failure into an indistinguishable "did not
  // announce port", which is what made the CI failures undiagnosable.
  const stderr = drain(proc.stderr as ReadableStream<Uint8Array>);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`inbox-daemon did not announce port within ${timeoutMs} ms.`)),
      timeoutMs,
    );
  });

  const scan = (async () => {
    for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      const m = buf.match(/listening on port (\d+)/);
      if (m) return parseInt(m[1], 10);
    }
    throw new Error('inbox-daemon stdout closed before announcing port.');
  })();

  try {
    return await Promise.race([scan, timeout]);
  } catch (err) {
    // Let stderr finish arriving and the exit status be reaped before quoting them,
    // but never hang on a daemon that is alive and simply holding the stream open.
    await Promise.race([
      Promise.all([stderr.settled, proc.exited.catch(() => undefined)]),
      Bun.sleep(500),
    ]);
    const errText = stderr.text().trim();
    const exited = proc.exitCode !== null ? ` exit code: ${proc.exitCode}.` : '';
    throw new Error(
      `${(err as Error).message}${exited}\n  stdout: ${buf.trim() || '(empty)'}\n` +
        `  stderr: ${errText || '(empty)'}`,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// readDaemonPort()'s whole job on failure is to say *why*. Its first draft read the stderr
// buffer before the drain had filled it and reported `stderr: (empty)` — the same defect it
// exists to fix, caught only by probing it by hand. Pin it.
describe('readDaemonPort diagnostics', () => {
  test('quotes the daemon stderr and exit status when it dies at startup', async () => {
    const proc = Bun.spawn(
      // Exit only once stderr has actually flushed: console.error() + an immediate
      // process.exit() can drop the text when stderr is a pipe, which would make this
      // test flaky in precisely the dimension it exists to pin.
      ['bun', '-e', 'process.stderr.write("port registry unreadable: EACCES\\n", () => process.exit(3));'],
      { stdout: 'pipe', stderr: 'pipe' },
    );

    let message = '';
    try {
      await readDaemonPort(proc, 2_000);
      throw new Error('expected readDaemonPort to reject');
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain('port registry unreadable: EACCES');
    expect(message).toContain('exit code: 3');
  }, 15_000);

  test('quotes stderr when the daemon is alive but never announces', async () => {
    const proc = Bun.spawn(
      ['bun', '-e', 'console.error("waiting on lock..."); setTimeout(() => {}, 30000);'],
      { stdout: 'pipe', stderr: 'pipe' },
    );

    let message = '';
    try {
      await readDaemonPort(proc, 500);
      throw new Error('expected readDaemonPort to reject');
    } catch (err) {
      message = (err as Error).message;
    } finally {
      proc.kill('SIGKILL');
    }

    expect(message).toContain('did not announce port');
    expect(message).toContain('waiting on lock...');
  }, 15_000);
});

describe('inbox-daemon HTTP server', () => {
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let tmpDir: string;
  let daemonPort: number;

  beforeAll(async () => {
    // Pick a free port before spawning so the daemon's reallocateInboxPort()
    // finds it in the pre-populated config and binds there deterministically.
    // There is a brief TOCTOU window between release and daemon bind, but in
    // practice on loopback this is negligible; the test never runs in CI under
    // extreme port pressure.
    const testPort = await findFreePort();

    // Isolated config: pre-populate port so reallocateInboxPort() returns testPort.
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'inbox-http-test-'));
    const configFile = path.join(tmpDir, 'config.json');
    await fsp.writeFile(
      configFile,
      JSON.stringify({
        _version: 1,
        portRegistry: { inbox: { [TEST_BRAIN_ID]: testPort } },
      }),
      'utf-8',
    );

    proc = Bun.spawn(
      ['bun', path.resolve('lib/daemon/inbox-daemon.mjs')],
      {
        env: {
          ...process.env,
          AGENTBOOTUP_BRAIN_ID: TEST_BRAIN_ID,
          AGENTBOOTUP_INBOX_PORT: String(testPort),
          AGENTBOOTUP_INBOX_WEBHOOK_SECRET: TEST_SECRET,
          AGENTBOOTUP_PROJECT_ROOT: os.tmpdir(),
          // Isolate port-registry + inboxEnabled reads from real config.
          AGENTBOOTUP_CONFIG_FILE: configFile,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    // Read the actual port from the daemon's stdout rather than polling a fixed URL.
    // The daemon may reallocate to a different port than testPort if it detects a
    // startup conflict (e.g., another test server grabbed testPort in the meantime).
    // "listening on port <N>" is the canonical startup announcement.
    daemonPort = await readDaemonPort(proc);
  });

  afterAll(async () => {
    if (proc) {
      proc.kill('SIGTERM');
      // Wait for the daemon to exit before cleaning up tmpDir — avoids races where
      // the daemon is still writing state files as we delete the directory.
      await Promise.race([proc.exited, Bun.sleep(2_000)]);
    }
    // Clean up the full tmpDir (config.json lives inside it).
    try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── Health ──────────────────────────────────────────────────────────────────

  test('GET /health → 200 with brainId and port', async () => {
    const r = await nativeFetch(`http://127.0.0.1:${daemonPort}/health`);
    const body = await r.json() as { status: string; brainId: string; port: number };
    expect(r.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.brainId).toBe(TEST_BRAIN_ID);
    expect(body.port).toBe(daemonPort);
  });

  // ── Signature verification ──────────────────────────────────────────────────

  /** Compute a wrong signature — signed with a different secret from the daemon's. */
  function makeWrongSig(payload: string): string {
    return 'sha256=' + crypto
      .createHmac('sha256', 'b'.repeat(64))
      .update(payload, 'utf8')
      .digest('hex');
  }

  test('POST /webhook with valid signature → 200', async () => {
    const payload = JSON.stringify({ to: TEST_BRAIN_ID, from: 'sender.gm', subject: 'ping' });
    const r = await nativeFetch(`http://127.0.0.1:${daemonPort}/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agentdispatch-signature': sign(payload),
      },
      body: payload,
    });
    expect(r.status).toBe(200);
    // Response body is 'OK' (addressed to this brain) or 'Skipped' (not).
    // For a message to TEST_BRAIN_ID we always get 'OK'.
    expect(await r.text()).toBe('OK');
  });

  test('POST /webhook missing signature header → 401', async () => {
    const payload = JSON.stringify({ to: TEST_BRAIN_ID });
    const r = await nativeFetch(`http://127.0.0.1:${daemonPort}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    expect(r.status).toBe(401);
  });

  test('POST /webhook wrong signature (bad hex value) → 401', async () => {
    const payload = JSON.stringify({ to: TEST_BRAIN_ID });
    const r = await nativeFetch(`http://127.0.0.1:${daemonPort}/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agentdispatch-signature': 'sha256=deadbeefdeadbeef',
      },
      body: payload,
    });
    expect(r.status).toBe(401);
  });

  test('POST /webhook signature for different secret → 401', async () => {
    const payload = JSON.stringify({ to: TEST_BRAIN_ID });
    const r = await nativeFetch(`http://127.0.0.1:${daemonPort}/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agentdispatch-signature': makeWrongSig(payload),
      },
      body: payload,
    });
    expect(r.status).toBe(401);
  });

  test('POST /webhook signature covers body (tampered body → 401)', async () => {
    const original = JSON.stringify({ to: TEST_BRAIN_ID, from: 'sender.gm' });
    const tampered = JSON.stringify({ to: TEST_BRAIN_ID, from: 'attacker.gm' });
    const r = await nativeFetch(`http://127.0.0.1:${daemonPort}/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Signature computed over original, but body is tampered.
        'x-agentdispatch-signature': sign(original),
      },
      body: tampered,
    });
    expect(r.status).toBe(401);
  });

  // ── Request parsing ─────────────────────────────────────────────────────────

  test('POST /webhook with invalid JSON (valid sig) → 400', async () => {
    const body = 'this is not json{{{';
    const r = await nativeFetch(`http://127.0.0.1:${daemonPort}/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agentdispatch-signature': sign(body),
      },
      body,
    });
    expect(r.status).toBe(400);
  });

  test('POST /webhook oversized body (content-length) → 413', async () => {
    // 65 537 bytes > 64 KB cap. Sign the real payload so signature is valid
    // — the size check runs before parsing, so the 413 fires regardless of sig.
    const oversized = 'x'.repeat(65_537);
    const r = await nativeFetch(`http://127.0.0.1:${daemonPort}/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(65_537),
        'x-agentdispatch-signature': sign(oversized),
      },
      body: oversized,
    });
    expect(r.status).toBe(413);
  });

  // ── Routing ─────────────────────────────────────────────────────────────────

  test('POST /webhook addressed to different brain → 200 Skipped', async () => {
    const payload = JSON.stringify({ to: 'someone-else.gm', from: 'sender.gm' });
    const r = await nativeFetch(`http://127.0.0.1:${daemonPort}/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agentdispatch-signature': sign(payload),
      },
      body: payload,
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('Skipped');
  });

  test('GET /unknown-path → 404', async () => {
    const r = await nativeFetch(`http://127.0.0.1:${daemonPort}/unknown`);
    expect(r.status).toBe(404);
  });

  test('POST /health → 404 (health is GET-only)', async () => {
    const r = await nativeFetch(`http://127.0.0.1:${daemonPort}/health`, { method: 'POST', body: '' });
    expect(r.status).toBe(404);
  });

  test('GET /webhook → 404 (webhook is POST-only)', async () => {
    const r = await nativeFetch(`http://127.0.0.1:${daemonPort}/webhook`);
    expect(r.status).toBe(404);
  });

  // ── Alternative signature headers ───────────────────────────────────────────

  test('POST /webhook with x-hub-signature-256 → 200 (GitHub-style sender)', async () => {
    const payload = JSON.stringify({ to: TEST_BRAIN_ID, from: 'github-actions', subject: 'deploy' });
    const r = await nativeFetch(`http://127.0.0.1:${daemonPort}/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(payload),
      },
      body: payload,
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('OK');
  });

  test('POST /webhook with x-brain-signature → 200 (same-machine caller)', async () => {
    const payload = JSON.stringify({ to: TEST_BRAIN_ID, from: 'custom-integration', subject: 'trigger' });
    const r = await nativeFetch(`http://127.0.0.1:${daemonPort}/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-brain-signature': sign(payload),
      },
      body: payload,
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('OK');
  });

  test('POST /webhook with wrong x-hub-signature-256 → 401', async () => {
    const payload = JSON.stringify({ to: TEST_BRAIN_ID });
    const r = await nativeFetch(`http://127.0.0.1:${daemonPort}/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': makeWrongSig(payload),
      },
      body: payload,
    });
    expect(r.status).toBe(401);
  });

  test('POST /webhook with wrong x-brain-signature → 401', async () => {
    const payload = JSON.stringify({ to: TEST_BRAIN_ID });
    const r = await nativeFetch(`http://127.0.0.1:${daemonPort}/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-brain-signature': makeWrongSig(payload),
      },
      body: payload,
    });
    expect(r.status).toBe(401);
  });

  test('POST /webhook all three signature headers present, all invalid → 401', async () => {
    const payload = JSON.stringify({ to: TEST_BRAIN_ID });
    const wrongSig = makeWrongSig(payload);
    const r = await nativeFetch(`http://127.0.0.1:${daemonPort}/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agentdispatch-signature': wrongSig,
        'x-hub-signature-256': wrongSig,
        'x-brain-signature': wrongSig,
      },
      body: payload,
    });
    expect(r.status).toBe(401);
  });

  test('POST /webhook with one invalid + one valid header → 200 (any-valid wins)', async () => {
    const payload = JSON.stringify({ to: TEST_BRAIN_ID, from: 'sender.gm' });
    const r = await nativeFetch(`http://127.0.0.1:${daemonPort}/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Invalid ADMP signature — but valid GitHub signature alongside it.
        'x-agentdispatch-signature': makeWrongSig(payload),
        'x-hub-signature-256': sign(payload),
      },
      body: payload,
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('OK');
  });
});
