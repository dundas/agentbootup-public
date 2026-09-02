import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import {
  writeCredentials,
  readCredentials,
  inspectCredentials,
  decryptLegacyWithHostname,
  formatCredentialsRecoveryMessage,
  CREDS_STATE_OK,
  CREDS_STATE_UNDECRYPTABLE,
  _resetAtRestKeyCache,
} from '../../lib/auth/credentials.js';

const CREDS = { apiKey: 'ab_test_key_123', serverUrl: 'https://agentbootup.fly.dev' };
const OTHER_MACHINE_ID = '11111111-2222-4333-8444-555555555555';

// Mirrors the legacy v1 recipe exactly: scryptSync(hostname + 'agentbootup-v1', SALT, 32),
// then raw iv|tag|ciphertext with no header.
const STATIC_SALT = Buffer.from('agentbootup-creds-v1-salt-32byts');
function writeLegacyCredsFile(filePath: string, hostname: string, creds = CREDS) {
  const key = crypto.scryptSync(hostname + 'agentbootup-v1', STATIC_SALT, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(JSON.stringify(creds), 'utf8'), cipher.final()]);
  fs.writeFileSync(filePath, Buffer.concat([iv, cipher.getAuthTag(), ct]), { mode: 0o600 });
}

const ENV_KEYS = ['AGENTBOOTUP_CREDS_FILE', 'AGENTBOOTUP_MACHINE_ID_FILE', 'AGENTBOOTUP_NO_CREDS_REWRAP'];

// Must await the callback INSIDE the try: returning the promise would restore the
// real hostname before any awaited work ran, and the hostname-sensitive assertions
// would silently pass against the real hostname instead of the stub.
async function withHostname(value: string, fn: () => Promise<void> | void): Promise<void> {
  const real = os.hostname;
  (os as { hostname: () => string }).hostname = () => value;
  try {
    await fn();
  } finally {
    (os as { hostname: () => string }).hostname = real;
  }
}

function makeHarness() {
  let dir = '';
  const saved: Record<string, string | undefined> = {};
  const ctx = { credsFile: '', machineIdFile: '' };

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-creds-'));
    ctx.credsFile = path.join(dir, 'credentials');
    ctx.machineIdFile = path.join(dir, 'machine-id');
    process.env.AGENTBOOTUP_CREDS_FILE = ctx.credsFile;
    process.env.AGENTBOOTUP_MACHINE_ID_FILE = ctx.machineIdFile;
    delete process.env.AGENTBOOTUP_NO_CREDS_REWRAP;
    _resetAtRestKeyCache();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    _resetAtRestKeyCache();
  });

  return ctx;
}

describe('credentials at-rest machine binding', () => {
  const ctx = makeHarness();

  test('round-trips and writes a v2 header', async () => {
    await writeCredentials(CREDS);
    const raw = fs.readFileSync(ctx.credsFile);
    expect(raw.subarray(0, 5).toString('latin1')).toBe('ABC2\0');
    expect(raw[5]).toBe(2);
    expect(await readCredentials()).toEqual(CREDS);
  });

  // The bug this change exists to fix.
  test('a hostname change does not invalidate v2 credentials', async () => {
    await writeCredentials(CREDS);
    await withHostname('totally-different-host.corp.example.com', async () => {
      _resetAtRestKeyCache();
      expect(await readCredentials()).toEqual(CREDS);
      expect((await inspectCredentials()).state).toBe(CREDS_STATE_OK);
    });
  });

  // The property the hostname binding was actually there to provide.
  test('the credentials file alone, copied to another host, does not decrypt', async () => {
    await writeCredentials(CREDS);
    fs.writeFileSync(ctx.machineIdFile, `${OTHER_MACHINE_ID}\n`);
    _resetAtRestKeyCache();

    const status = await inspectCredentials();
    expect(status.state).toBe(CREDS_STATE_UNDECRYPTABLE);
    expect(status.format).toBe('v2');
    // The diagnostic names both key ids rather than vaguely blaming "this host".
    expect(status.keyIdOnFile).toBeTruthy();
    expect(status.keyIdOnHost).toBeTruthy();
    expect(status.keyIdOnFile).not.toBe(status.keyIdOnHost);
    const msg = formatCredentialsRecoveryMessage(status);
    expect(msg).toContain('cannot be decrypted on this host');
    expect(msg).toContain(status.keyIdOnFile!);
    expect(msg).toContain(status.keyIdOnHost!);
  });

  test('a missing machine-id file is reported, and never silently regenerated', async () => {
    await writeCredentials(CREDS);
    expect(fs.existsSync(ctx.machineIdFile)).toBe(true);
    fs.rmSync(ctx.machineIdFile);
    _resetAtRestKeyCache();

    const status = await inspectCredentials();
    expect(status.state).toBe(CREDS_STATE_UNDECRYPTABLE);
    expect(status.keyIdOnHost).toBeNull();
    expect(formatCredentialsRecoveryMessage(status)).toContain('missing, corrupt, or unreadable');
    // Decrypting must not have minted a replacement id: that would permanently
    // orphan the credentials file.
    expect(fs.existsSync(ctx.machineIdFile)).toBe(false);
  });

  test('the key cache does not survive an identity change', async () => {
    await writeCredentials(CREDS);
    expect(await readCredentials()).toEqual(CREDS); // populates the cache
    fs.writeFileSync(ctx.machineIdFile, `${OTHER_MACHINE_ID}\n`);
    // No explicit cache reset: the cache is keyed on the material it was derived from.
    expect(await readCredentials()).toBeNull();
  });

  test('a corrupt machine-id is reported on read, and never replaced on write', async () => {
    await writeCredentials(CREDS);
    fs.writeFileSync(ctx.machineIdFile, 'not-a-uuid\n');
    _resetAtRestKeyCache();

    // Read: diagnosable, and the corrupt file is left alone for the operator to inspect.
    const status = await inspectCredentials();
    expect(status.state).toBe(CREDS_STATE_UNDECRYPTABLE);
    expect(formatCredentialsRecoveryMessage(status)).toContain('missing, corrupt, or unreadable');
    expect(fs.readFileSync(ctx.machineIdFile, 'utf8').trim()).toBe('not-a-uuid');

    // Write: refuses to mint a replacement, which would orphan the existing v2 file.
    await expect(writeCredentials(CREDS)).rejects.toThrow(/not a valid UUID|Refusing to mint/);
    expect(fs.readFileSync(ctx.machineIdFile, 'utf8').trim()).toBe('not-a-uuid');
  });

  test('an absent machine-id is created on write (first-run), not on read', async () => {
    expect(fs.existsSync(ctx.machineIdFile)).toBe(false);
    expect(await readCredentials()).toBeNull();
    expect(fs.existsSync(ctx.machineIdFile)).toBe(false); // read never mints

    await writeCredentials(CREDS);
    expect(fs.existsSync(ctx.machineIdFile)).toBe(true); // write does
  });

  // readCredentials()/inspectCredentials() are documented as never throwing. A read
  // failure on machine-id that is not ENOENT (EACCES, EISDIR, an odd ACL) must resolve
  // to "cannot derive", not reject — otherwise the caller prints a raw errno instead of
  // the recovery guidance this module works hard to produce.
  test('an unreadable machine-id degrades gracefully on the decrypt path', async () => {
    await writeCredentials(CREDS);
    fs.rmSync(ctx.machineIdFile);
    fs.mkdirSync(ctx.machineIdFile); // reading a directory yields EISDIR, not ENOENT
    _resetAtRestKeyCache();

    await expect(readCredentials()).resolves.toBeNull();
    const status = await inspectCredentials();
    expect(status.state).toBe(CREDS_STATE_UNDECRYPTABLE);
    expect(formatCredentialsRecoveryMessage(status)).toContain('missing, corrupt, or unreadable');
  });

  test('an unreadable machine-id fails the write path loudly, without minting one', async () => {
    fs.mkdirSync(ctx.machineIdFile);
    _resetAtRestKeyCache();
    await expect(writeCredentials(CREDS)).rejects.toThrow(/could not be read/);
    expect(fs.statSync(ctx.machineIdFile).isDirectory()).toBe(true);
  });

  test('writes are atomic: mode 0600 and no .tmp left behind', async () => {
    await writeCredentials(CREDS);
    expect(fs.existsSync(`${ctx.credsFile}.tmp`)).toBe(false);
    expect(fs.statSync(ctx.credsFile).mode & 0o777).toBe(0o600);
  });
});

describe('legacy v1 migration', () => {
  const ctx = makeHarness();

  test('reads a v1 file encrypted under the current hostname and rewraps it to v2', async () => {
    await withHostname('workstation-7.lan', async () => {
      writeLegacyCredsFile(ctx.credsFile, 'workstation-7.lan');
      expect(fs.readFileSync(ctx.credsFile).subarray(0, 4).toString('latin1')).not.toBe('ABC2');

      expect(await readCredentials()).toEqual(CREDS);
      expect(fs.readFileSync(ctx.credsFile).subarray(0, 5).toString('latin1')).toBe('ABC2\0');
    });

    // Now on a completely unrelated hostname: the v2 file is unaffected, which is the
    // whole point of the change.
    await withHostname('moved-networks.corp.example.com', async () => {
      _resetAtRestKeyCache();
      expect(await readCredentials()).toEqual(CREDS);
    });
  });

  test('recovers the common drift case: only the domain suffix changed', async () => {
    // Encrypted on a network that handed out `.local`; the host now reports a domain
    // that is not in the candidate list at all, so recovery must come from the
    // `<base>.local` candidate rather than from the current hostname.
    writeLegacyCredsFile(ctx.credsFile, 'workstation-7.local');
    await withHostname('workstation-7.corp-vpn.example.com', async () => {
      expect(await readCredentials()).toEqual(CREDS);
      expect(fs.readFileSync(ctx.credsFile).subarray(0, 5).toString('latin1')).toBe('ABC2\0');
    });
  });

  test('the bare base hostname is also a recovery candidate', async () => {
    writeLegacyCredsFile(ctx.credsFile, 'workstation-7');
    await withHostname('workstation-7.lan', async () => {
      expect(await readCredentials()).toEqual(CREDS);
      expect(fs.readFileSync(ctx.credsFile).subarray(0, 5).toString('latin1')).toBe('ABC2\0');
    });
  });

  test('AGENTBOOTUP_NO_CREDS_REWRAP=1 reads the legacy file without migrating it', async () => {
    process.env.AGENTBOOTUP_NO_CREDS_REWRAP = '1';
    writeLegacyCredsFile(ctx.credsFile, os.hostname());
    expect(await readCredentials()).toEqual(CREDS);
    // Still v1 on the read path, so an older agentbootup on the same host can still read it.
    expect(fs.readFileSync(ctx.credsFile).subarray(0, 4).toString('latin1')).not.toBe('ABC2');
  });

  // The flag is not a mixed-version compatibility mode, and the docs must not claim it is:
  // encryptAtRest() has no v1 output path, so the next write locks an older install out
  // whether or not the operator set the flag. Pin that, so nobody restores the friendlier
  // and false promise in docs/CLI_REFERENCE.md.
  test('AGENTBOOTUP_NO_CREDS_REWRAP=1 does NOT keep writes in the legacy format', async () => {
    process.env.AGENTBOOTUP_NO_CREDS_REWRAP = '1';
    writeLegacyCredsFile(ctx.credsFile, os.hostname());

    await writeCredentials(CREDS);

    expect(fs.readFileSync(ctx.credsFile).subarray(0, 5).toString('latin1')).toBe('ABC2\0');
    expect(await readCredentials()).toEqual(CREDS);
  });

  // Regression for the real failure on this host: os.hostname() returns the lowercased
  // `macbook-pro-5.lan`, but the credentials were encrypted under the Bonjour name
  // `MacBook-Pro-5.local`. Candidates derived from os.hostname() alone can never
  // reproduce that capitalisation, so scutil --get LocalHostName is consulted too.
  const localHostName = (() => {
    if (process.platform !== 'darwin') return null;
    try {
      return execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch {
      return null;
    }
  })();

  // The test is only *meaningful* where the Bonjour name differs from os.hostname()'s
  // base by case — that difference is the bug. Where it doesn't (Linux, or a Mac whose
  // LocalHostName is already lowercase), the cheap candidates would cover it and there
  // is nothing to prove, so skip rather than assert on the reviewer's machine config.
  const bonjourDiffersByCase =
    !!localHostName &&
    localHostName !== os.hostname().split('.')[0] &&
    localHostName.toLowerCase() === os.hostname().split('.')[0].toLowerCase();

  test.skipIf(!bonjourDiffersByCase)(
    'recovers a file encrypted under the Bonjour LocalHostName (differs only by case)',
    async () => {
      writeLegacyCredsFile(ctx.credsFile, `${localHostName}.local`);
      expect(await readCredentials()).toEqual(CREDS);
      expect(fs.readFileSync(ctx.credsFile).subarray(0, 5).toString('latin1')).toBe('ABC2\0');
    },
  );

  // Platform-independent proof of the same property: a candidate that differs from
  // os.hostname() only by case is NOT reachable from the cheap list, which is why the
  // Bonjour lookup exists at all.
  test('cheap candidates cannot recover a case-differing hostname on their own', async () => {
    await withHostname('workstation-7.lan', async () => {
      writeLegacyCredsFile(ctx.credsFile, 'Workstation-7.local');
      expect(await readCredentials()).toBeNull();
      expect(fs.readFileSync(ctx.credsFile).subarray(0, 4).toString('latin1')).not.toBe('ABC2');
    });
  });

  test('unrecoverable drift reports the legacy cause and points at auth rewrap', async () => {
    // A changed mDNS collision counter: no candidate can guess `-99` from the current name.
    writeLegacyCredsFile(ctx.credsFile, 'macbook-pro-99.some-corp-vpn.example.com');
    const status = await inspectCredentials();
    expect(status.state).toBe(CREDS_STATE_UNDECRYPTABLE);
    expect(status.format).toBe('v1');
    const msg = formatCredentialsRecoveryMessage(status);
    expect(msg).toContain('cannot be decrypted on this host');
    expect(msg).toContain('legacy hostname-bound format');
    expect(msg).toContain('auth rewrap --from-hostname');
  });

  test('decryptLegacyWithHostname recovers an explicitly-named old hostname', async () => {
    const oldHost = 'macbook-pro-99.some-corp-vpn.example.com';
    writeLegacyCredsFile(ctx.credsFile, oldHost);
    const raw = fs.readFileSync(ctx.credsFile);

    expect(decryptLegacyWithHostname(raw, 'wrong-host')).toBeNull();
    expect(JSON.parse(decryptLegacyWithHostname(raw, oldHost)!)).toEqual(CREDS);
  });

  test('decryptLegacyWithHostname refuses a v2 file', async () => {
    await writeCredentials(CREDS);
    expect(decryptLegacyWithHostname(fs.readFileSync(ctx.credsFile), os.hostname())).toBeNull();
  });

  test('a corrupt legacy file is not rewrapped', async () => {
    fs.writeFileSync(ctx.credsFile, crypto.randomBytes(80));
    expect(await readCredentials()).toBeNull();
    // Never replace a diagnosable file with a v2 wrapper around garbage.
    expect(fs.readFileSync(ctx.credsFile).subarray(0, 4).toString('latin1')).not.toBe('ABC2');
  });
});

// ── scutil is not re-spawned on every read ───────────────────────────────────
//
// transcript-sync and brain-asset-sync call inspectCredentials() on a 30s poll. A file
// whose hostname drifted beyond what scutil reports (renamed host, bumped mDNS collision
// counter) never decrypts and therefore never migrates, so the Bonjour fallback stays
// reachable forever. Re-spawning a subprocess on every tick — synchronously, in the
// original — is what the review flagged. Assert the lookup happens at most once by
// putting a counting `scutil` on PATH.
describe('legacy Bonjour fallback', () => {
  const ctx = makeHarness();

  test.skipIf(process.platform !== 'darwin')(
    'resolves scutil at most once per process',
    async () => {
      const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-scutil-shim-'));
      const counter = path.join(shimDir, 'calls');
      fs.writeFileSync(
        path.join(shimDir, 'scutil'),
        `#!/bin/sh\necho call >> ${JSON.stringify(counter)}\necho never-matches-this-host\n`,
        { mode: 0o755 },
      );
      const prevPath = process.env.PATH;
      process.env.PATH = `${shimDir}:${prevPath}`;

      try {
        _resetAtRestKeyCache(); // clears the memoized lookup too
        // A hostname no candidate can guess, so the Bonjour fallback is always reached.
        writeLegacyCredsFile(ctx.credsFile, 'a-host-that-never-existed-42');

        expect(await readCredentials()).toBeNull();
        expect(await readCredentials()).toBeNull();
        expect(await readCredentials()).toBeNull();

        const calls = fs.existsSync(counter)
          ? fs.readFileSync(counter, 'utf-8').trim().split('\n').filter(Boolean).length
          : 0;
        expect(calls).toBe(1);
      } finally {
        process.env.PATH = prevPath;
        fs.rmSync(shimDir, { recursive: true, force: true });
        _resetAtRestKeyCache();
      }
    },
  );
});

// Memoizing a *failure* would let one `scutil` timeout under load permanently cost a
// long-lived daemon its only route to recovering a legacy file.
describe('legacy Bonjour fallback — transient failure', () => {
  const ctx = makeHarness();

  test.skipIf(process.platform !== 'darwin')('a transient scutil failure is not memoized', async () => {
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbootup-scutil-flaky-'));
    const shim = [
      '#!/bin/sh',
      'echo call >> "$0.calls"',
      'if [ "$(wc -l < "$0.calls" | tr -d " ")" = "1" ]; then exit 1; fi',
      'echo never-matches-this-host',
      '',
    ].join('\n');
    const shimPath = path.join(shimDir, 'scutil');
    fs.writeFileSync(shimPath, shim, { mode: 0o755 });

    const prevPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${prevPath}`;

    try {
      _resetAtRestKeyCache();
      writeLegacyCredsFile(ctx.credsFile, 'a-host-that-never-existed-42');

      expect(await readCredentials()).toBeNull(); // scutil fails
      expect(await readCredentials()).toBeNull(); // must retry, not reuse the failure
      expect(await readCredentials()).toBeNull(); // now memoized on the success

      const calls = fs.readFileSync(`${shimPath}.calls`, 'utf-8').trim().split('\n').filter(Boolean).length;
      expect(calls).toBe(2); // one failure, one success — the success is cached
    } finally {
      process.env.PATH = prevPath;
      fs.rmSync(shimDir, { recursive: true, force: true });
      _resetAtRestKeyCache();
    }
  });
});

// A shared `${target}.tmp` lets concurrent writers scribble over each other's staged
// bytes. The rewrap-on-read added here makes that reachable: transcript-sync and
// brain-asset-sync poll inspectCredentials() every 30s, so a daemon's rewrap can overlap
// an `auth login`. The loser is not an error — it is a credentials file that decrypts to
// somebody else's key, or to nothing at all, while the write reported success.
describe('writeCredentials under concurrency', () => {
  const ctx = makeHarness();

  test('concurrent writers never corrupt the credentials file', async () => {
    const keys = Array.from({ length: 6 }, (_, i) => `ab_key_${i}_${'x'.repeat(2000)}`);

    for (let round = 0; round < 15; round++) {
      await Promise.all(
        keys.map((apiKey) => writeCredentials({ apiKey, serverUrl: CREDS.serverUrl })),
      );

      const got = await readCredentials();
      // Whoever won, the file must hold exactly one writer's intent — never a blend.
      expect(got).not.toBeNull();
      expect(keys).toContain(got!.apiKey);

      const stray = fs.readdirSync(path.dirname(ctx.credsFile)).filter((n) => n.endsWith('.tmp'));
      expect(stray).toEqual([]);
    }
  }, 30_000);
});

// The stale-read-then-write race, distinct from the shared-tmp one:
//   t0  a polling daemon reads the legacy v1 file and decrypts the OLD credentials
//   t1  `auth login` writes NEW credentials and returns success
//   t2  the daemon's in-flight rewrap (scrypt is slow) publishes what it read at t0
// The newer key is silently reverted. Only live while a host still has a v1 file — i.e.
// during exactly the v1->v2 migration this change introduces.
describe('rewrap-on-read vs a concurrent write', () => {
  const ctx = makeHarness();

  test('a stale rewrap never reverts a newer credential write', async () => {
    const OLD = { apiKey: 'ab_old_key', serverUrl: CREDS.serverUrl };
    const NEW = { apiKey: 'ab_new_key', serverUrl: CREDS.serverUrl };

    for (let round = 0; round < 8; round++) {
      writeLegacyCredsFile(ctx.credsFile, os.hostname(), OLD);
      _resetAtRestKeyCache();

      // t0: the daemon starts reading (and will rewrap). Do not await it yet.
      const daemonRead = readCredentials();
      // t1: the login lands while the rewrap is still deriving its scrypt key.
      await writeCredentials(NEW);
      // t2: let the rewrap finish.
      await daemonRead;

      const onDisk = await readCredentials();
      expect(onDisk).not.toBeNull();
      expect(onDisk!.apiKey).toBe(NEW.apiKey); // never reverted to OLD
    }
  }, 30_000);
});
