/**
 * Persistent machine identifier.
 *
 * Returns a stable, random UUID stored at ~/.agentbootup/machine-id (mode 0o600).
 * On first call the ID is generated and persisted; subsequent calls return the
 * same value. This is more reliable than os.hostname() in container and cloud
 * environments where multiple machines may share identical hostname prefixes.
 *
 * The file path can be overridden via AGENTBOOTUP_MACHINE_ID_FILE for testing.
 */

import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { withFileLock } from '../util/file-lock.js';

// Re-exported under its historical name: tests drive the lock through this entry point.
export const _withMintLock = withFileLock;

/**
 * Return machine metadata for tracing sync origins.
 * Note: IP address is intentionally excluded — it is PII under GDPR/CCPA and
 * provides no attribution value beyond what machine_id (stable UUID) already provides.
 * @returns {{ hostname: string, os_type: string, os_release: string, platform: string }}
 */
export function getMachineInfo() {
  try {
    return {
      hostname: os.hostname(),
      os_type: os.type(),
      os_release: os.release(),
      platform: os.platform(),
    };
  } catch {
    // OS calls unavailable (e.g. sandboxed or containerized environment).
    return { hostname: '', os_type: '', os_release: '', platform: '' };
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getMachineIdPath() {
  return (
    process.env.AGENTBOOTUP_MACHINE_ID_FILE ||
    path.join(os.homedir(), '.agentbootup', 'machine-id')
  );
}

/**
 * Read the persistent machine ID **without creating it**, distinguishing an absent
 * file from a present-but-corrupt one.
 *
 * Decryption paths must never mint a new identity: silently generating a fresh UUID
 * would guarantee that an existing credentials file can no longer be decrypted,
 * converting a recoverable state into a permanent one.
 *
 * Callers that mint an identity (credential *writes*) must never treat "corrupt" as
 * "absent": silently generating a replacement would orphan an existing credentials
 * file bound to the old id. Absent is a first-run condition; corrupt is an operator
 * problem that has to surface.
 *
 * Never throws. A read failure other than ENOENT (EACCES, EISDIR, EIO, an odd NFS
 * or ACL state) is reported as `unreadable` rather than propagating: callers on the
 * decrypt path are documented as returning null instead of rejecting, and a raw
 * `EACCES: permission denied` is a strictly worse message than the recovery guidance
 * those callers already know how to print.
 *
 * @returns {Promise<{ id: string | null, state: 'ok' | 'absent' | 'invalid' | 'unreadable', error?: Error }>}
 */
export async function readMachineIdState() {
  let content;
  try {
    content = await fsp.readFile(getMachineIdPath(), 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { id: null, state: 'absent' };
    return { id: null, state: 'unreadable', error: err instanceof Error ? err : new Error(String(err)) };
  }
  const id = content.trim();
  if (UUID_RE.test(id)) return { id, state: 'ok' };
  return { id: null, state: 'invalid' };
}

/** Trimmed file contents, or null if the file is absent. Rethrows other read errors. */
async function readIdOrNull(filePath) {
  try {
    return (await fsp.readFile(filePath, 'utf-8')).trim();
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}


/**
 * Return the persistent machine ID, creating it if it does not exist.
 *
 * Creation is **exclusive**, not last-write-wins. Credentials are encrypted against this
 * id, so two processes that each mint a different UUID (a daemon starting alongside
 * `auth login`, two CLI calls in a fresh container) would leave the loser's freshly
 * written credentials bound to an id no longer on disk — permanently orphaned, which is
 * the failure this id exists to prevent. The same applies when regenerating over corrupt
 * content: by then a racer may already have published a valid id that credentials are
 * bound to, so replacing it unconditionally reintroduces exactly the same orphaning.
 *
 * @returns {Promise<string>}
 */
export async function getMachineId() {
  const filePath = getMachineIdPath();

  // Fast path: an established id needs no lock.
  const existing = await readIdOrNull(filePath);
  if (existing !== null && UUID_RE.test(existing)) return existing;

  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await fsp.chmod(dir, 0o700);

  return withFileLock(filePath, async () => {
    // Re-read under the lock: whoever held it before us may have published already.
    const current = await readIdOrNull(filePath);
    if (current !== null && UUID_RE.test(current)) return current;

    if (current !== null) {
      // Regenerating causes server data to accumulate under a new machine ID, which is
      // safer than sending untrusted file content onward.
      process.stderr.write(
        `[machine-id] WARNING: ${filePath} contains invalid content. Regenerating machine ID.\n`,
      );
    }

    const id = randomUUID();
    // Write atomically via a temp file to avoid a partially-written UUID on SIGKILL. The
    // name is unique per call: a shared `.tmp` lets concurrent writers overwrite each
    // other's staged content, and the pid alone is not unique because two awaits in one
    // process reach here too.
    const tmpFile = `${filePath}.${process.pid}.${id}.tmp`;
    try {
      await fsp.writeFile(tmpFile, id + '\n', { mode: 0o600 });

      if (current === null) {
        // First run. Publish exclusively — link() fails rather than clobbering — and adopt
        // whoever won if we lost. This makes the common path correct even if the lock was
        // wrongly stolen from us (see _withMintLock: a process suspended past the stale
        // threshold cannot be distinguished from a dead one without a kernel-backed lock).
        try {
          await fsp.link(tmpFile, filePath);
          return id;
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
          const winner = await readIdOrNull(filePath);
          if (winner !== null && UUID_RE.test(winner)) return winner;
          throw new Error(`${filePath} was created concurrently with invalid content.`);
        }
      }

      // Replacing corrupt content is the one overwrite, and the only step whose safety
      // rests on the lock. It is reachable only while the id is unusable — and credential
      // writes refuse to mint over a corrupt id (see atRestKeyMaterial, verified by test),
      // so no credentials can be bound to an id during the window in which this overwrites.
      await fsp.rename(tmpFile, filePath);

      // Return what is actually persisted, not what we intended to persist. If the lock
      // was stolen from us while suspended and a racer's rename landed last, `id` is no
      // longer the machine's identity, and handing it back would break this function's
      // only contract. The residual gap is a rename landing after this read; it cannot
      // orphan credentials (see above), and it is bounded to a corrupt-file recovery.
      const persisted = await readIdOrNull(filePath);
      if (persisted !== null && UUID_RE.test(persisted)) return persisted;
      return id;
    } finally {
      await fsp.rm(tmpFile, { force: true }).catch(() => {});
    }
  });
}
