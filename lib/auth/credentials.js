/**
 * AES-256-GCM credentials store at ~/.agentbootup/credentials.
 *
 * Threat model: this provides obfuscation against casual on-disk inspection,
 * not protection against an attacker who has read access to the file. The
 * key-derivation recipe and static salt are in public source, and the machine
 * identity is readable by any local process, so a motivated attacker with
 * file-read access can derive the key. The binding to machine identity prevents
 * accidental cross-host use, not adversarial decryption.
 *
 * For stronger at-rest protection use OS keychain storage (e.g. keytar) or
 * derive the key from a user passphrase. The current implementation is
 * intentionally lightweight and dependency-free.
 *
 * AT-REST KEY DERIVATION
 * ----------------------
 * v2 (current): scrypt(`${machineId}:agentbootup-v2`, SALT, 32) where machineId is
 *   the persisted random UUID at ~/.agentbootup/machine-id. It survives renames,
 *   network changes, and package upgrades, and differs on every host — so copying
 *   the credentials file to another machine still fails, which is the property the
 *   hostname binding was there to provide.
 *
 * v1 (legacy): scryptSync(os.hostname() + 'agentbootup-v1', SALT, 32)
 *   os.hostname() is the LEAST stable identifier on macOS: with `scutil --get
 *   HostName` unset (the default) it is synthesised from DHCP/mDNS, so it
 *   changes with the network domain (`.lan` -> `.local`) and with the mDNS
 *   collision counter (`macbook-pro-5` -> `macbook-pro-6`). Joining a different
 *   Wi-Fi network silently invalidated the key. A process-lifetime key cache hid
 *   this until the next restart, which made it look like upgrades were at fault.
 *   v1 files are transparently re-wrapped to v2 on first successful read.
 *
 * TRANSPORT (handoff) binding is deliberately different: exportCredentialsPayload
 * encrypts for a *target hostname*, because that is the only thing the source
 * host knows about the target. Handoff is a transport format, not at-rest.
 *
 * File format v2 (binary):
 *   [5 bytes: magic "ABC2\0"][1 byte: version=2][12 bytes: key id]
 *   [12 bytes: IV][16 bytes: auth tag][remainder: ciphertext]
 *
 * File format v1 (legacy, headerless):
 *   [12 bytes: IV][16 bytes: auth tag][remainder: ciphertext]
 *
 * The v2 key id is a truncated sha256 of the key material (never the material
 * itself). It lets us say "encrypted for machine <a>, this host is <b>" instead
 * of the useless "cannot be decrypted", and distinguishes a wrong key from a
 * corrupt file.
 *
 * Directory mode 0o700, file mode 0o600.
 */

import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { getMachineId, readMachineIdState } from '../machine-id/machine-id.js';
import { withFileLock } from '../util/file-lock.js';

export const CREDS_DIR = path.join(os.homedir(), '.agentbootup');
export const CREDS_FILE = path.join(CREDS_DIR, 'credentials');
/** Local-only, machine-bound encrypted device material; never portable auth data. */
export const REMOTE_LOCAL_CONNECTOR_STATE_FILE = path.join(CREDS_DIR, 'remote-local-connector');
function remoteLocalConnectorStateFile() { return process.env.AGENTBOOTUP_REMOTE_LOCAL_CONNECTOR_STATE_FILE ?? REMOTE_LOCAL_CONNECTOR_STATE_FILE; }

const STATIC_SALT = Buffer.from('agentbootup-creds-v1-salt-32byts');
const ALGORITHM = 'aes-256-gcm';
const KEY_LEN = 32;
/** 96-bit IV per NIST SP 800-38D recommendation for AES-GCM. */
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;
export const CREDS_HANDOFF_KIND = 'agentbootup-credentials-handoff';
export const CREDS_HANDOFF_VERSION = 1;
export const DEFAULT_CREDS_HANDOFF_TTL_SECONDS = 3600;
export const CREDS_STATE_MISSING = 'missing';
export const CREDS_STATE_OK = 'ok';
export const CREDS_STATE_UNDECRYPTABLE = 'undecryptable';
export const CREDS_STATE_READ_ERROR = 'read_error';

/** v2 on-disk header. */
const V2_MAGIC = Buffer.from('ABC2\0', 'latin1');
const V2_VERSION = 2;
const KEY_ID_LEN = 12;
const V2_HEADER_LEN = V2_MAGIC.length + 1 + KEY_ID_LEN;

/**
 * Explain *why* a credentials file will not decrypt.
 *
 * Every message keeps the canonical opening sentence — operators, docs, and a number
 * of tests grep for it — and then appends the cause and the remedy. The v1 format
 * carries no key id, so there the best we can do is name the likely cause (hostname
 * drift). The v2 format carries one, so we can state the mismatch outright.
 */
function formatUndecryptableMessage(credentialState) {
  const detail = typeof credentialState === 'object' && credentialState ? credentialState : {};
  const base = 'Credentials file exists but cannot be decrypted on this host.';
  const relogin = 'Re-run: agentbootup auth login --api-key <key>';

  if (detail.format === 'v2') {
    if (!detail.keyIdOnHost) {
      return (
        `${base} They are bound to this machine, but ~/.agentbootup/machine-id is missing, corrupt, or unreadable, ` +
        `so the key cannot be derived (file expects key ${detail.keyIdOnFile}). ` +
        `Restore that file from backup, or start over: ${relogin}`
      );
    }
    return (
      `${base} They were encrypted for machine key ${detail.keyIdOnFile}, but this host ` +
      `derives ${detail.keyIdOnHost} — the credentials belong to a different machine, or ` +
      `this machine's identity changed. ${relogin}`
    );
  }

  if (detail.format === 'v1') {
    return (
      `${base} They use the legacy hostname-bound format, and this host's hostname has ` +
      `changed (it is now "${os.hostname()}"), so the key no longer derives. macOS rewrites ` +
      'the hostname when the network domain or mDNS name changes. If you know the previous ' +
      'hostname: agentbootup auth rewrap --from-hostname <old-hostname>. Otherwise: ' +
      relogin
    );
  }

  // Format unknown: a bare state string, from a caller that holds only the enum. Reachable
  // and covered — not dead code. See the note on formatCredentialsRecoveryMessage.
  return `${base} If this followed a hostname change, try: agentbootup auth rewrap --from-hostname <old-hostname>. Otherwise: ${relogin}`;
}

/**
 * Accepts either an inspectCredentials() result or a bare state string. The bare form is
 * not legacy: callers that hold only the enum still use it (see tests/auth/credentials.test.ts),
 * and it is why formatUndecryptableMessage keeps a format-unknown branch.
 *
 * @param {{
 *   state:
 *     | typeof CREDS_STATE_MISSING
 *     | typeof CREDS_STATE_UNDECRYPTABLE
 *     | typeof CREDS_STATE_READ_ERROR
 *     | typeof CREDS_STATE_OK,
 *   format?: 'v1' | 'v2',
 *   keyIdOnFile?: string | null,
 *   keyIdOnHost?: string | null,
 *   error?: Error
 * } | typeof CREDS_STATE_MISSING | typeof CREDS_STATE_UNDECRYPTABLE | typeof CREDS_STATE_READ_ERROR | typeof CREDS_STATE_OK} credentialState
 * @param {{ missingMessage?: string, includeErrorDetail?: boolean }} [options]
 */
export function formatCredentialsRecoveryMessage(credentialState, options = {}) {
  const state = typeof credentialState === 'string' ? credentialState : credentialState?.state;
  const missingMessage =
    options.missingMessage ?? 'No credentials found. Run: agentbootup auth login --api-key <key>';
  const includeErrorDetail = options.includeErrorDetail === true;

  if (state === CREDS_STATE_UNDECRYPTABLE) {
    return formatUndecryptableMessage(credentialState);
  }
  if (state === CREDS_STATE_READ_ERROR) {
    const base = 'Credentials file exists but could not be read on this host. Check file permissions/path and try again.';
    if (
      includeErrorDetail &&
      credentialState &&
      typeof credentialState === 'object' &&
      credentialState.error instanceof Error
    ) {
      return `${base} (${credentialState.error.message})`;
    }
    return base;
  }
  return missingMessage;
}

// Cached at-rest key — scrypt is intentionally expensive; cache avoids re-deriving
// on every call within a single process invocation. Keyed by the material it was
// derived from, so a changed identity can never silently reuse a stale key.
let _atRestKey = null;
let _atRestKeyMaterial = null;

/**
 * v1 (legacy) key derivation. Retained for two reasons: reading pre-v2 files so
 * they can be migrated, and the handoff transport format, which binds to a target
 * hostname by design.
 */
function deriveKeyForHostname(hostname) {
  const password = hostname + 'agentbootup-v1';
  return crypto.scryptSync(password, STATIC_SALT, KEY_LEN);
}

function keyIdFor(material) {
  return crypto.createHash('sha256').update(material).digest().subarray(0, KEY_ID_LEN);
}

/**
 * The material the at-rest key is derived from: the persisted machine-id UUID and
 * nothing else.
 *
 * An earlier revision of this change also mixed in an OS-level identity
 * (IOPlatformUUID / /etc/machine-id), to make a copy of the *entire* ~/.agentbootup
 * directory fail on a different host. Adversarial review killed it: that lookup
 * shells out on darwin, and a transient failure would silently swap the key material,
 * reintroducing exactly the intermittent, restart-triggered, silent credential
 * failure this change exists to fix — only worse, because it flaps. The failure could
 * not even be repaired on read, since an unavailable OS identity cannot be
 * reconstructed.
 *
 * The property it bought was never in the threat model: this file "prevents accidental
 * cross-host use, not adversarial decryption", and anyone copying the whole directory
 * has the ciphertext anyway. Copying just `credentials` — the realistic accident —
 * still fails, because the machine-id on the destination host differs.
 *
 * @param {{ create?: boolean }} [options] create the machine-id file when absent.
 *   Never true on a decrypt path — minting a fresh id would permanently orphan an
 *   existing credentials file.
 * @returns {Promise<string | null>} null when no machine-id exists and create=false
 */
async function atRestKeyMaterial({ create = false } = {}) {
  // The machine-id file is re-read on every call rather than cached. It is one small
  // read, and it is what makes the derived-key cache correct: the cache is keyed on
  // the material, so an identity that changes underneath a long-lived process is
  // picked up instead of being served a stale key.
  const { id, state, error } = await readMachineIdState();
  if (state === 'ok') return `${id}:agentbootup-v2`;

  // Decrypt path: absent, corrupt, and unreadable all mean "cannot derive". Returning
  // null keeps readCredentials()/inspectCredentials() to their documented contract of
  // never throwing, so the caller prints recovery guidance instead of a raw EACCES.
  if (!create) return null;

  // Write path. `getMachineId()` regenerates on invalid content by design, which is
  // right for its other callers (telemetry attribution) and wrong here: minting a new
  // identity over a corrupt file would orphan any existing v2 credentials bound to the
  // old one — the exact failure this module exists to prevent. Absent is a legitimate
  // first-run condition; corrupt is an operator problem that must surface.
  if (state === 'invalid') {
    throw new Error(
      'The machine identity file (~/.agentbootup/machine-id) exists but is not a valid UUID. ' +
        'Refusing to mint a replacement, because that would permanently orphan any credentials ' +
        'bound to the previous identity. Inspect or delete the file, then re-run: ' +
        'agentbootup auth login --api-key <key>',
    );
  }
  if (state === 'unreadable') {
    throw new Error(
      `The machine identity file (~/.agentbootup/machine-id) could not be read: ${error?.message}. ` +
        'Refusing to mint a replacement, because that would permanently orphan any credentials ' +
        'bound to the existing identity. Fix the file permissions and retry.',
    );
  }
  return `${await getMachineId()}:agentbootup-v2`;
}

function keyForMaterial(material) {
  if (_atRestKey && _atRestKeyMaterial === material) return _atRestKey;
  _atRestKey = crypto.scryptSync(material, STATIC_SALT, KEY_LEN);
  _atRestKeyMaterial = material;
  return _atRestKey;
}

/** Test seam: drop the cached key so a changed identity is picked up. */
export function _resetAtRestKeyCache() {
  _atRestKey = null;
  _atRestKeyMaterial = null;
  _bonjourCandidates = null;
}

/**
 * Plausible past values of os.hostname() to try when reading a v1 file. macOS
 * synthesises the hostname from DHCP/mDNS, so the value that encrypted the file is
 * usually a near-miss of the current one: a different domain suffix from the router
 * (`.lan` vs `.local` vs none), and — crucially — a different CASE.
 *
 * This host is the worked example. `os.hostname()` now returns the lowercased
 * `macbook-pro-5.lan`, but the credentials were encrypted under the Bonjour name
 * `MacBook-Pro-5.local`. Deriving candidates from `os.hostname()` alone can never
 * reproduce that capitalisation, so `scutil --get LocalHostName` (which preserves it)
 * is consulted as well.
 *
 * It still cannot recover a changed mDNS collision counter (`-5` -> `-6`) or a rename;
 * for those the operator supplies the old name (see `decryptLegacyWithHostname`).
 */
function withDomainVariants(name) {
  return [name, `${name}.local`, `${name}.lan`];
}

function legacyHostnameCandidates() {
  const current = os.hostname();
  const base = current.split('.')[0];
  return [...new Set([current, ...withDomainVariants(base)].filter(Boolean))];
}

/** Memoized `scutil` lookup; see legacyBonjourCandidates(). */
let _bonjourCandidates = null;

/**
 * Second-chance candidates, tried only after the cheap ones fail. Never reached on the
 * steady-state (v2) path — only on a legacy file that is already failing to decrypt.
 *
 * Two properties matter here, and an earlier revision had neither:
 *
 * `execFile`, not `execFileSync`. `inspectCredentials()` is called by transcript-sync and
 * brain-asset-sync on a 30s poll; a synchronous subprocess would block the whole event
 * loop for up to its timeout on every tick.
 *
 * Memoized. The reachable case is *not* "once, then it migrates": a file whose hostname
 * drifted beyond what `scutil` currently reports (a renamed host, a bumped mDNS collision
 * counter) never decrypts and so never migrates, leaving the daemon to re-spawn `scutil`
 * forever. `LocalHostName` cannot usefully change within one process lifetime, so resolve
 * it at most once. The in-flight promise is cached, not just the result, so concurrent
 * callers share a single spawn.
 *
 * Only a *completed* lookup is memoized. Pinning a transient failure — `scutil` timing
 * out under load — would make one bad moment permanently cost a long-lived daemon its
 * only route to recovering a legacy file.
 */
function legacyBonjourCandidates() {
  if (_bonjourCandidates) return _bonjourCandidates;
  _bonjourCandidates = (async () => {
    if (process.platform !== 'darwin') return [];
    try {
      const { stdout } = await promisify(execFile)('scutil', ['--get', 'LocalHostName'], {
        encoding: 'utf8',
        timeout: 2_000,
      });
      const localHostName = stdout.trim();
      return localHostName ? withDomainVariants(localHostName) : [];
    } catch {
      _bonjourCandidates = null; // transient — let the next read retry
      return [];
    }
  })();
  return _bonjourCandidates;
}

function isV2(data) {
  return (
    data.length >= V2_HEADER_LEN + IV_LEN + AUTH_TAG_LEN &&
    data.subarray(0, V2_MAGIC.length).equals(V2_MAGIC) &&
    data[V2_MAGIC.length] === V2_VERSION
  );
}

function v2KeyId(data) {
  return data.subarray(V2_MAGIC.length + 1, V2_HEADER_LEN);
}

function encryptWithKey(plaintext, key) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LEN });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

function decryptWithKey(data, key) {
  if (data.length < IV_LEN + AUTH_TAG_LEN + 1) return null;
  const iv = data.subarray(0, IV_LEN);
  const authTag = data.subarray(IV_LEN, IV_LEN + AUTH_TAG_LEN);
  const ciphertext = data.subarray(IV_LEN + AUTH_TAG_LEN);
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LEN });
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Encrypt at rest in v2 format, creating the machine-id file if needed. */
async function encryptAtRest(plaintext) {
  // getMachineId() creates the file, so the material always exists here.
  const material = await atRestKeyMaterial({ create: true });
  const body = encryptWithKey(plaintext, keyForMaterial(material));
  return Buffer.concat([V2_MAGIC, Buffer.from([V2_VERSION]), keyIdFor(material), body]);
}

/**
 * Decrypt an at-rest blob of either format.
 *
 * @returns {Promise<{
 *   plaintext: string | null,
 *   format: 'v1' | 'v2',
 *   needsRewrap: boolean,
 *   keyIdOnFile?: string,
 *   keyIdOnHost?: string | null,
 * }>}
 */
async function decryptAtRest(data) {
  if (isV2(data)) {
    const fileKeyId = v2KeyId(data);
    const material = await atRestKeyMaterial({ create: false });
    const body = data.subarray(V2_HEADER_LEN);
    const plaintext = material ? decryptWithKey(body, keyForMaterial(material)) : null;
    return {
      plaintext,
      format: 'v2',
      needsRewrap: false,
      keyIdOnFile: fileKeyId.toString('hex'),
      keyIdOnHost: material ? keyIdFor(material).toString('hex') : null,
    };
  }

  // Legacy headerless file: try plausible past hostnames, cheapest first. A success
  // means the file is readable but stale-format; the caller re-wraps it to v2.
  const cheap = legacyHostnameCandidates();
  for (const hostname of cheap) {
    const plaintext = decryptWithKey(data, deriveKeyForHostname(hostname));
    if (plaintext !== null) return { plaintext, format: 'v1', needsRewrap: true };
  }
  // Only now pay for a subprocess, on a file that is otherwise about to be declared
  // unreadable. Never reached on the v2 steady-state path.
  for (const hostname of await legacyBonjourCandidates()) {
    if (cheap.includes(hostname)) continue;
    const plaintext = decryptWithKey(data, deriveKeyForHostname(hostname));
    if (plaintext !== null) return { plaintext, format: 'v1', needsRewrap: true };
  }
  return { plaintext: null, format: 'v1', needsRewrap: false };
}

/**
 * Decrypt a legacy v1 file with an operator-supplied hostname. The escape hatch for
 * drift that legacyHostnameCandidates() cannot guess (a changed mDNS collision
 * counter, a rename, a move between networks with unrelated domains).
 *
 * @param {Buffer} data
 * @param {string} hostname the hostname the file was encrypted under
 * @returns {string | null}
 */
export function decryptLegacyWithHostname(data, hostname) {
  if (isV2(data)) return null;
  return decryptWithKey(data, deriveKeyForHostname(hostname));
}

function validateCredsShape(creds) {
  return !!creds && typeof creds.apiKey === 'string' && typeof creds.serverUrl === 'string';
}

/** Exposed for `auth rewrap`, which decrypts out-of-band before re-encrypting. */
export function parseCredentialsPlaintextForRewrap(plaintext) {
  return parseCredentialsPlaintext(plaintext);
}

function parseCredentialsPlaintext(plaintext) {
  try {
    const parsed = JSON.parse(plaintext);
    return validateCredsShape(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Persist credentials to ~/.agentbootup/credentials.
 * Creates ~/.agentbootup with mode 0o700 if absent.
 * Writes the encrypted file with mode 0o600.
 *
 * @param {{ apiKey: string, serverUrl: string }} creds
 */
export async function writeCredentials(creds) {
  const targetFile = process.env.AGENTBOOTUP_CREDS_FILE ?? CREDS_FILE;
  const targetDir = path.dirname(targetFile);
  // recursive: true means mkdir does not throw when the directory already
  // exists (Node 10.12+). Re-throw for any other error (e.g. permissions).
  await fsp.mkdir(targetDir, { recursive: true, mode: 0o700 });
  await fsp.chmod(targetDir, 0o700);
  const plaintext = JSON.stringify(creds);
  const encrypted = await encryptAtRest(plaintext);
  // Serialized against rewrapToV2(): a compare-and-swap before rename() has its own
  // window — the file can change between the check and the rename — and under Bun's
  // scheduling that interleaving reproduces every run. Holding the lock across the
  // publish is what makes the CAS in rewrapToV2 sound.
  await withFileLock(targetFile, () => writeFileAtomic(targetFile, encrypted));
}

/**
 * Write via tmp + rename so a crash mid-write cannot truncate the credentials file.
 * Migration fires on *read* paths, which are far more frequent than writes, so a
 * non-atomic write here would turn a readable file into a corrupt one. Mirrors the
 * pattern already used by machine-id.js, config.js and sync-state.js.
 */
async function writeFileAtomic(targetFile, contents) {
  // Unique per call. A shared `${targetFile}.tmp` lets concurrent writers overwrite each
  // other's staged bytes: this PR added an opportunistic rewrap on *read*, and
  // inspectCredentials() is polled every 30s by transcript-sync and brain-asset-sync, so
  // a daemon's rewrap can now overlap an `auth login`. With one tmp name, the login's
  // rename() publishes whatever is at that path — possibly the daemon's stale key — and
  // reports success while the new key is silently lost.
  const tmpFile = `${targetFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(tmpFile, contents, { mode: 0o600 });
  try {
    await fsp.rename(tmpFile, targetFile);
    return true;
  } catch (err) {
    await fsp.rm(tmpFile, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Re-encrypt a readable file in the preferred v2 form, in place. Best-effort: a
 * failure here (read-only home, race with another writer) must not fail the read that
 * triggered it — the credentials were successfully decrypted either way.
 *
 * Re-wrapping is a one-way door: an agentbootup older than this change cannot read a v2
 * file. It fails closed — the old reader reports "cannot be decrypted on this host"
 * rather than surfacing garbage — but it is locked out until it is upgraded.
 *
 * AGENTBOOTUP_NO_CREDS_REWRAP=1 suppresses *this* opportunistic rewrap, and nothing
 * more. It is not a compatibility mode: encryptAtRest() has no v1 output path, so every
 * credential write — `auth login`, device-login approval, token refresh — emits v2
 * regardless of the flag. An operator running mixed versions on one host (e.g. a
 * bun-global 0.8.22 alongside a newer npm-global) is protected only until the next write.
 * The supported answer is to upgrade every install on the host together, or to pin.
 */
async function rewrapToV2(targetFile, plaintext, expectedRaw) {
  if (process.env.AGENTBOOTUP_NO_CREDS_REWRAP === '1') return false;
  try {
    // `plaintext` was decrypted from `expectedRaw` some time ago — encryptAtRest() derives
    // a scrypt key, which is deliberately slow. An `auth login` can land in that gap. If it
    // did, the file no longer holds `expectedRaw` and this migration is both unnecessary and
    // destructive: it would republish the credentials this read saw, reverting the newer
    // ones with no error. Publish only if nothing moved underneath us.
    const encrypted = await encryptAtRest(plaintext);
    return await withFileLock(targetFile, async () => {
      // Inside the lock: nobody can publish between this check and the rename below.
      const current = await fsp.readFile(targetFile).catch(() => null);
      if (current === null || !current.equals(expectedRaw)) return false;
      return await writeFileAtomic(targetFile, encrypted);
    });
  } catch {
    return false;
  }
}

/**
 * Read and decrypt credentials from ~/.agentbootup/credentials.
 * Returns null if the file is absent or decryption fails (e.g. tampered data,
 * wrong host, or invalid JSON after decryption).
 *
 * @returns {Promise<{ apiKey: string, serverUrl: string } | null>}
 */
export async function readCredentials() {
  const targetFile = process.env.AGENTBOOTUP_CREDS_FILE ?? CREDS_FILE;
  let raw;
  try {
    raw = await fsp.readFile(targetFile);
  } catch {
    return null;
  }
  const { plaintext, needsRewrap } = await decryptAtRest(raw);
  if (plaintext === null) return null;
  const creds = parseCredentialsPlaintext(plaintext);
  // Migrate the on-disk format only once we know the contents are valid; re-wrapping
  // garbage would replace a diagnosable legacy file with a diagnosable v2 one.
  if (creds && needsRewrap) await rewrapToV2(targetFile, plaintext, raw);
  return creds;
}

/**
 * Read encrypted local-device connector state. This record is deliberately
 * separate from exportable API credentials. AES-GCM rejects tampering or a
 * substituted foreign file; a valid stale record is denied by the relay fence.
 */
export async function readRemoteLocalConnectorState() {
  const targetFile = remoteLocalConnectorStateFile();
  let raw;
  try { raw = await fsp.readFile(targetFile); } catch { return null; }
  const { plaintext } = await decryptAtRest(raw);
  if (plaintext === null) return null;
  try {
    const parsed = JSON.parse(plaintext);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

/** Persist local-only encrypted connector state for the enrollment workflow. */
export async function writeRemoteLocalConnectorState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('remote-local connector state must be an object');
  const targetFile = remoteLocalConnectorStateFile();
  const targetDir = path.dirname(targetFile);
  await fsp.mkdir(targetDir, { recursive: true, mode: 0o700 });
  await fsp.chmod(targetDir, 0o700);
  const encrypted = await encryptAtRest(JSON.stringify(state));
  await withFileLock(targetFile, () => writeFileAtomic(targetFile, encrypted));
}

/**
 * Distinguish missing credentials from a present-but-unreadable credentials
 * file (wrong host binding, tampering, or invalid contents).
 *
 * @returns {Promise<
 *   | { state: typeof CREDS_STATE_MISSING }
 *   | { state: typeof CREDS_STATE_UNDECRYPTABLE }
 *   | { state: typeof CREDS_STATE_READ_ERROR, error: Error }
 *   | { state: typeof CREDS_STATE_OK, creds: { apiKey: string, serverUrl: string } }
 * >}
 */
export async function inspectCredentials() {
  const targetFile = process.env.AGENTBOOTUP_CREDS_FILE ?? CREDS_FILE;
  let raw;
  try {
    raw = await fsp.readFile(targetFile);
  } catch (err) {
    if (err && typeof err === 'object' && err.code === 'ENOENT') {
      return { state: CREDS_STATE_MISSING };
    }
    return {
      state: CREDS_STATE_READ_ERROR,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  const { plaintext, format, needsRewrap, keyIdOnFile, keyIdOnHost } = await decryptAtRest(raw);
  if (plaintext === null) {
    // Carry the key ids so the operator learns *why* — "encrypted for machine <a>,
    // this host derives <b>" is actionable; "cannot be decrypted" is not.
    return { state: CREDS_STATE_UNDECRYPTABLE, format, keyIdOnFile, keyIdOnHost };
  }
  const creds = parseCredentialsPlaintext(plaintext);
  if (!creds) {
    return { state: CREDS_STATE_UNDECRYPTABLE, format, keyIdOnFile, keyIdOnHost };
  }
  if (needsRewrap) await rewrapToV2(targetFile, plaintext, raw);
  return { state: CREDS_STATE_OK, creds };
}

/**
 * Build a host-bound credential handoff payload for trusted local transport.
 *
 * @param {{ apiKey: string, serverUrl: string }} creds
 * @param {string} targetHostname
 * @returns {string}
 */
export function exportCredentialsPayload(creds, targetHostname, options = {}) {
  if (!validateCredsShape(creds)) {
    throw new Error('credentials handoff requires apiKey and serverUrl');
  }
  if (typeof targetHostname !== 'string' || !targetHostname.trim()) {
    throw new Error('credentials handoff requires a non-empty target hostname');
  }
  const ttlSeconds =
    options.ttlSeconds == null ? DEFAULT_CREDS_HANDOFF_TTL_SECONDS : Number(options.ttlSeconds);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('credentials handoff requires a positive ttlSeconds');
  }

  const normalizedTarget = targetHostname.trim();
  const ciphertext = encryptWithKey(
    JSON.stringify({
      creds,
      source_hostname: os.hostname(),
    }),
    deriveKeyForHostname(normalizedTarget)
  ).toString('base64');
  return JSON.stringify({
    kind: CREDS_HANDOFF_KIND,
    version: CREDS_HANDOFF_VERSION,
    target_hostname: normalizedTarget,
    exported_at: new Date().toISOString(),
    ttl_seconds: ttlSeconds,
    ciphertext,
  });
}

/**
 * Decrypt and validate a host-bound credential handoff payload for this host.
 *
 * @param {string} rawPayload
 * @returns {{ apiKey: string, serverUrl: string }}
 */
export function importCredentialsPayload(rawPayload) {
  let parsed;
  try {
    parsed = JSON.parse(rawPayload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid credential handoff payload: ${msg}`);
  }

  if (!parsed || parsed.kind !== CREDS_HANDOFF_KIND || parsed.version !== CREDS_HANDOFF_VERSION) {
    throw new Error('invalid credential handoff payload: unsupported kind or version');
  }
  if (typeof parsed.target_hostname !== 'string' || !parsed.target_hostname.trim()) {
    throw new Error('invalid credential handoff payload: missing target_hostname');
  }
  if (parsed.target_hostname.trim() !== os.hostname()) {
    throw new Error(
      `credential handoff payload is for host "${parsed.target_hostname}", not this host "${os.hostname()}"`
    );
  }
  if (typeof parsed.ciphertext !== 'string' || !parsed.ciphertext.trim()) {
    throw new Error('invalid credential handoff payload: missing ciphertext');
  }
  const ttlSeconds = Number(parsed.ttl_seconds ?? DEFAULT_CREDS_HANDOFF_TTL_SECONDS);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('invalid credential handoff payload: ttl_seconds must be a positive number');
  }
  const exportedAt = Date.parse(parsed.exported_at);
  if (!Number.isFinite(exportedAt)) {
    throw new Error('invalid credential handoff payload: exported_at is invalid');
  }
  if (Date.now() - exportedAt > ttlSeconds * 1000) {
    throw new Error('invalid credential handoff payload: payload has expired');
  }

  let ciphertext;
  try {
    ciphertext = Buffer.from(parsed.ciphertext, 'base64');
  } catch {
    throw new Error('invalid credential handoff payload: ciphertext is not valid base64');
  }

  const plaintext = decryptWithKey(ciphertext, deriveKeyForHostname(os.hostname()));
  if (plaintext === null) {
    throw new Error('invalid credential handoff payload: decryption failed');
  }

  let creds;
  try {
    creds = JSON.parse(plaintext);
  } catch {
    throw new Error('invalid credential handoff payload: credentials JSON is invalid');
  }
  if (!creds || typeof creds !== 'object' || Array.isArray(creds) || !validateCredsShape(creds.creds)) {
    throw new Error('invalid credential handoff payload: credentials are incomplete');
  }
  return creds.creds;
}

/**
 * Returns true if ~/.agentbootup/credentials exists (does not attempt decryption).
 *
 * @returns {Promise<boolean>}
 */
export async function credentialsExist() {
  const targetFile = process.env.AGENTBOOTUP_CREDS_FILE ?? CREDS_FILE;
  try {
    await fsp.access(targetFile);
    return true;
  } catch {
    return false;
  }
}
