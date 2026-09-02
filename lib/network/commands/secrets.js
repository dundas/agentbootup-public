/**
 * Manual sync for secret files (.env, .dev.vars, brain/config.secret.json).
 *
 * Usage:
 *   agentbootup secrets push [--dry-run] [--cwd <path>]
 *   agentbootup secrets pull [--force] [--dry-run] [--cwd <path>]
 *
 * Only the allowlisted paths in lib/brain/secret-sources.js are pushed or pulled.
 * The daemon never syncs these; this is manual-only.
 *
 * Security and responsibility
 * --------------------------
 * - Server: The authenticated capabilities endpoint is checked before any secret
 *   bytes are transmitted. A missing or incompatible contract fails closed.
 * - User: Run secrets push/pull only from trusted environments (your own machine or
 *   explicitly trusted automation). Do not run from shared machines or CI unless you
 *   accept the risk of secrets being stored on the server. The CLI does not provide
 *   an audit trail of who pushed or pulled secrets or when.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readCredentials } from '../../auth/credentials.js';
import { apiUrl, isValidServerUrl } from '../../auth/validate.js';
import { brainAssetPushHeaders } from '../../brain-asset-headers.js';
import {
  ASSET_CONTRACT_VERSION,
  ASSET_TYPES,
  MAX_SECRET_BYTES,
  SECRET_CAPABILITY_POLICY,
  SECRET_ASSET_TYPE,
  SECRET_REL_PATHS,
  SECRET_TTL_MAX_SECONDS,
  SECRET_TTL_MIN_SECONDS,
  isCanonicalBase64,
  isSecretAssetPath,
} from '../../brain/asset-contract.js';
import { resolveProjectAgentId } from '../../project-config.js';

const PUSH_TIMEOUT_MS = 30_000;
function resolveSecretsBrainId(cwd, io, command) {
  try {
    return resolveProjectAgentId(cwd);
  } catch (err) {
    io.stderr(`${command} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

const BUN_PULL_HELPER = fileURLToPath(new URL('./secrets-pull-bun.js', import.meta.url));
const BUN_PUSH_HELPER = fileURLToPath(new URL('./secrets-push-bun.js', import.meta.url));

export function resolveTrustedSecretsBun(env = process.env) {
  const configured = env.AGENTBOOTUP_BUN_PATH;
  if (typeof configured !== 'string' || !path.isAbsolute(configured)) {
    throw new Error('set AGENTBOOTUP_BUN_PATH to the trusted absolute Bun executable path');
  }
  const info = fs.lstatSync(configured);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error('AGENTBOOTUP_BUN_PATH must name a regular file, not a symlink');
  }
  if ((info.mode & 0o022) !== 0) {
    throw new Error('AGENTBOOTUP_BUN_PATH must not be writable by group or other users');
  }
  fs.accessSync(configured, fs.constants.X_OK);
  return configured;
}

export function buildSecretsChildEnv(env = process.env) {
  const childEnv = {
    PATH: process.platform === 'win32'
      ? String(env.SystemRoot ? `${env.SystemRoot}\\System32` : '')
      : '/usr/bin:/bin:/usr/sbin:/sbin',
  };
  for (const key of [
    'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot',
    'LANG', 'LC_ALL', 'AGENTBOOTUP_CREDS_FILE', 'AGENTBOOTUP_NO_CREDS_REWRAP',
  ]) {
    if (typeof env[key] === 'string') childEnv[key] = env[key];
  }
  return childEnv;
}

function relayChildOutput(bytes, writer) {
  const text = bytes.toString('utf8');
  for (const line of text.split(/\r?\n/)) {
    if (line) writer(line);
  }
}

async function delegateSecretsPullToBun(cwd, io, opts) {
  if (opts.restoreHooks !== undefined || opts.readCredentialsImpl !== undefined) {
    io.stderr('secrets pull failed: injected hooks are available only inside the Bun runtime');
    return 1;
  }
  const encoded = Buffer.from(JSON.stringify({
    cwd,
    force: opts.force === true,
    dryRun: opts.dryRun === true,
    expectedServerUrl: opts.expectedServerUrl,
  }), 'utf8').toString('base64');
  let bunExecutable;
  try {
    bunExecutable = resolveTrustedSecretsBun();
  } catch (err) {
    io.stderr(`secrets pull failed: secure restore requires Bun (${err instanceof Error ? err.message : String(err)})`);
    return 1;
  }
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(bunExecutable, [BUN_PULL_HELPER, encoded], {
      env: buildSecretsChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      io.stderr(`secrets pull failed: secure restore requires Bun (${err.message})`);
      resolve(1);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      relayChildOutput(Buffer.concat(stdout), io.stdout);
      relayChildOutput(Buffer.concat(stderr), io.stderr);
      resolve(code === 0 ? 0 : 1);
    });
  });
}

async function delegateSecretsPushToBun(cwd, io, opts) {
  if (opts.readHooks !== undefined || opts.readCredentialsImpl !== undefined) {
    io.stderr('secrets push failed: injected hooks are available only inside the Bun runtime');
    return 1;
  }
  const encoded = Buffer.from(JSON.stringify({
    cwd,
    ttlSeconds: opts.ttlSeconds,
    expectedServerUrl: opts.expectedServerUrl,
  }), 'utf8').toString('base64');
  let bunExecutable;
  try {
    bunExecutable = resolveTrustedSecretsBun();
  } catch (err) {
    io.stderr(`secrets push failed: secure read requires Bun (${err instanceof Error ? err.message : String(err)})`);
    return 1;
  }
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(bunExecutable, [BUN_PUSH_HELPER, encoded], {
      env: buildSecretsChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      io.stderr(`secrets push failed: secure read requires Bun (${err.message})`);
      resolve(1);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      relayChildOutput(Buffer.concat(stdout), io.stdout);
      relayChildOutput(Buffer.concat(stderr), io.stderr);
      resolve(code === 0 ? 0 : 1);
    });
  });
}

async function resolveCommandCredentials(opts) {
  if (opts.readCredentialsImpl === undefined) return readCredentials();
  if (typeof opts.readCredentialsImpl !== 'function') {
    throw new TypeError('readCredentialsImpl must be a function');
  }
  return opts.readCredentialsImpl();
}

function hasSymlinkWithin(root, relPath) {
  let current = root;
  for (const segment of relPath.split('/')) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    if (fs.lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

function advertisedPolicy(secret) {
  if (secret === null || typeof secret !== 'object') return null;
  return {
    supported: secret.supported,
    asset_type: secret.asset_type,
    manual_only: secret.manual_only,
    exact_bytes: secret.exact_bytes,
    paths: secret.paths,
    max_file_bytes: secret.max_file_bytes,
    retention: secret.retention,
    ttl: secret.ttl,
    authorization: secret.authorization,
    logging: secret.logging,
    restore: secret.restore,
    cleanup: secret.cleanup,
  };
}

function matchesCanonicalSecretPolicy(secret) {
  return JSON.stringify(advertisedPolicy(secret))
    === JSON.stringify(SECRET_CAPABILITY_POLICY);
}

async function preflightSecretContract({
  serverUrl,
  apiKey,
  brainId,
  localFiles = [],
  ttlSeconds,
  requireRestore = false,
}, io, operation) {
  const endpoint = apiUrl(
    serverUrl,
    `/v1/brain-assets/${encodeURIComponent(brainId)}/capabilities`,
  );
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: brainAssetPushHeaders(apiKey),
      signal: controller.signal,
    });
    if (!response.ok) {
      io.stderr(`${operation} contract preflight failed: HTTP ${response.status}`);
      return false;
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      io.stderr(`${operation} contract preflight failed: server returned malformed JSON`);
      return false;
    }
    const contract = payload?.data;
    const secret = contract?.secret;
    if (
      contract?.contract_version !== ASSET_CONTRACT_VERSION
      || !Array.isArray(contract?.asset_types)
      || JSON.stringify(contract.asset_types) !== JSON.stringify(ASSET_TYPES)
      || !matchesCanonicalSecretPolicy(secret)
    ) {
      io.stderr(
        `${operation} contract preflight failed: server does not advertise the required secret asset capability`,
      );
      return false;
    }
    if (
      localFiles.some((file) =>
        !secret.paths.includes(file.path) || file.size > secret.max_file_bytes)
    ) {
      io.stderr(
        `${operation} contract preflight failed: server capability would reject the requested secret path or size`,
      );
      return false;
    }
    if (
      ttlSeconds !== undefined
      && (
        secret?.ttl?.supported !== true
        || !Number.isSafeInteger(secret?.ttl?.min_seconds)
        || !Number.isSafeInteger(secret?.ttl?.max_seconds)
        || ttlSeconds < secret.ttl.min_seconds
        || ttlSeconds > secret.ttl.max_seconds
      )
    ) {
      io.stderr(`${operation} contract preflight failed: server capability would reject the requested TTL`);
      return false;
    }
    if (
      requireRestore
      && (
        secret?.restore?.explicit_pull_only !== true
        || secret?.restore?.method !== 'GET'
      )
    ) {
      io.stderr(`${operation} contract preflight failed: server does not advertise explicit secret restore`);
      return false;
    }
    return true;
  } catch (err) {
    if (err?.name === 'AbortError') {
      io.stderr(`${operation} contract preflight failed: request timed out`);
    } else {
      io.stderr(`${operation} contract preflight failed: ${err.message}`);
    }
    return false;
  } finally {
    clearTimeout(timerId);
  }
}

function discoverLocalSecretFiles(root, io) {
  let rootStat;
  let canonicalRoot;
  try {
    rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error('project root is not a real directory');
    }
    canonicalRoot = fs.realpathSync(root);
  } catch (err) {
    io.stderr(`secrets push failed: unsafe project root: ${err.message}`);
    return null;
  }
  const files = [];
  for (const relPath of SECRET_REL_PATHS) {
    const fullPath = path.join(root, relPath);
    if (!fs.existsSync(fullPath)) continue;
    try {
      let current = root;
      const parentIdentities = [];
      const segments = relPath.split('/');
      for (const segment of segments.slice(0, -1)) {
        current = path.join(current, segment);
        const parentStat = fs.lstatSync(current);
        if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
          throw new Error('traverses a symbolic link or non-directory parent');
        }
        parentIdentities.push({ segment, logicalPath: current, stat: parentStat });
      }
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) throw new Error('target is a symbolic link');
      if (!stat.isFile()) continue;
      if (stat.nlink !== 1) throw new Error('target has multiple hard links');
      if (stat.size > MAX_SECRET_BYTES) {
        io.stderr(
          `secrets push failed: ${relPath} exceeds 1 MB limit (${stat.size} bytes) — refusing to push`,
        );
        return null;
      }
      files.push({
        path: relPath,
        size: stat.size,
        stat,
        parentIdentities,
      });
    } catch (err) {
      io.stderr(`secrets push failed: could not inspect ${relPath}: ${err.message}`);
      return null;
    }
  }
  return { files, rootStat, canonicalRoot };
}

function parseSecretPullResponse(payload, io) {
  const files = payload?.data?.files;
  if (!Array.isArray(files)) {
    io.stderr('secrets pull failed: server returned a malformed secret asset list');
    return null;
  }
  const seen = new Set();
  const parsed = [];
  for (const asset of files) {
    if (
      asset === null
      || typeof asset !== 'object'
      || asset.asset_type !== SECRET_ASSET_TYPE
      || asset.cli !== 'shared'
      || !isSecretAssetPath(asset.path)
      || seen.has(asset.path)
      || !isCanonicalBase64(asset.content_base64)
    ) {
      io.stderr('secrets pull failed: server returned an invalid secret asset contract');
      return null;
    }
    const bytes = Buffer.from(asset.content_base64, 'base64');
    if (bytes.byteLength > MAX_SECRET_BYTES) {
      io.stderr('secrets pull failed: server returned an oversized secret asset');
      return null;
    }
    seen.add(asset.path);
    parsed.push({ path: asset.path, bytes });
  }
  return parsed;
}

let directoryRelativeFsPromise;

function cString(value) {
  return Buffer.from(`${value}\0`);
}

async function getDirectoryRelativeFs() {
  if (directoryRelativeFsPromise) return directoryRelativeFsPromise;
  directoryRelativeFsPromise = (async () => {
    if (
      process.platform === 'win32'
      || !fs.constants.O_NOFOLLOW
      || !fs.constants.O_DIRECTORY
    ) {
      throw new Error('secure secret restore requires POSIX openat/O_NOFOLLOW support');
    }
    let ffi;
    try {
      ffi = await import('bun:ffi');
    } catch {
      throw new Error('secure secret restore requires the Bun POSIX FFI runtime');
    }
    const libraryPath = process.platform === 'darwin'
      ? '/usr/lib/libSystem.B.dylib'
      : 'libc.so.6';
    const library = ffi.dlopen(libraryPath, {
      openat: {
        args: [ffi.FFIType.i32, ffi.FFIType.cstring, ffi.FFIType.i32, ffi.FFIType.i32],
        returns: ffi.FFIType.i32,
      },
      mkdirat: {
        args: [ffi.FFIType.i32, ffi.FFIType.cstring, ffi.FFIType.u32],
        returns: ffi.FFIType.i32,
      },
      renameat: {
        args: [ffi.FFIType.i32, ffi.FFIType.cstring, ffi.FFIType.i32, ffi.FFIType.cstring],
        returns: ffi.FFIType.i32,
      },
      unlinkat: {
        args: [ffi.FFIType.i32, ffi.FFIType.cstring, ffi.FFIType.i32],
        returns: ffi.FFIType.i32,
      },
    });
    return { library, ...library.symbols };
  })();
  return directoryRelativeFsPromise;
}

async function prepareSecureRestore(restoreHooks = {}) {
  if (restoreHooks.noFollowSupported === false) {
    throw new Error('secure secret restore requires POSIX openat/O_NOFOLLOW support');
  }
  return getDirectoryRelativeFs();
}

function openDirectoryAt(api, parentFd, segment, { create = false } = {}) {
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  let fd = api.openat(parentFd, cString(segment), flags, 0);
  let created = false;
  if (fd < 0 && create) {
    created = api.mkdirat(parentFd, cString(segment), 0o700) === 0;
    fd = api.openat(parentFd, cString(segment), flags, 0);
  }
  if (fd < 0) {
    throw new Error(`destination directory '${segment}' is missing, replaced, or not a real directory`);
  }
  const stat = fs.fstatSync(fd);
  if (!stat.isDirectory()) {
    fs.closeSync(fd);
    throw new Error(`destination directory '${segment}' is not a real directory`);
  }
  if (created) fs.fchmodSync(fd, 0o700);
  return { fd, stat };
}

function inspectDestinationAt(api, parentFd, name) {
  const readFlags = fs.constants.O_RDONLY
    | fs.constants.O_NOFOLLOW
    | (fs.constants.O_NONBLOCK ?? 0);
  const fd = api.openat(parentFd, cString(name), readFlags, 0);
  if (fd >= 0) {
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new Error('destination is not a regular file');
      return { exists: true, stat };
    } finally {
      fs.closeSync(fd);
    }
  }

  // Distinguish an absent entry from a symlink or unsupported file without
  // trusting errno or a pathname lstat: only an absent name can be reserved
  // with O_EXCL through this already-open parent descriptor.
  const probeFd = api.openat(
    parentFd,
    cString(name),
    fs.constants.O_WRONLY
      | fs.constants.O_CREAT
      | fs.constants.O_EXCL
      | fs.constants.O_NOFOLLOW,
    0o600,
  );
  if (probeFd < 0) {
    throw new Error('destination appeared as a symlink or unsupported file');
  }
  fs.closeSync(probeFd);
  if (api.unlinkat(parentFd, cString(name), 0) !== 0) {
    throw new Error('could not remove secure destination probe');
  }
  return { exists: false, stat: null };
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left, right) {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function assertOpenDirectoryStillBound(fd, expectedStat, logicalPath, canonicalRoot) {
  const fdStat = fs.fstatSync(fd);
  if (!fdStat.isDirectory() || !sameFileIdentity(fdStat, expectedStat)) {
    throw new Error('open destination directory changed during restore');
  }
  const pathStat = fs.lstatSync(logicalPath);
  if (
    pathStat.isSymbolicLink()
    || !pathStat.isDirectory()
    || !sameFileIdentity(pathStat, expectedStat)
  ) {
    throw new Error('destination parent changed during restore');
  }
  const canonical = fs.realpathSync(logicalPath);
  const relative = path.relative(canonicalRoot, canonical);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('destination parent escapes the restore root');
  }
}

function unlinkAtIfPresent(api, parentFd, name) {
  api.unlinkat(parentFd, cString(name), 0);
}

async function readLocalSecretFilesSecurely(root, discovery, readHooks, io) {
  let api;
  let rootFd = -1;
  try {
    api = await prepareSecureRestore(readHooks);
    rootFd = fs.openSync(
      root,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    if (!sameFileIdentity(fs.fstatSync(rootFd), discovery.rootStat)) {
      throw new Error('project root changed before secure open');
    }
    assertOpenDirectoryStillBound(
      rootFd,
      discovery.rootStat,
      root,
      discovery.canonicalRoot,
    );

    const files = [];
    for (const local of discovery.files) {
      const openedDirectories = [];
      let fileFd = -1;
      try {
        let parentFd = rootFd;
        let parentStat = discovery.rootStat;
        let parentLogicalPath = root;
        for (const expected of local.parentIdentities) {
          const opened = openDirectoryAt(api, parentFd, expected.segment);
          openedDirectories.push(opened.fd);
          if (!sameFileIdentity(opened.stat, expected.stat)) {
            throw new Error('secret parent changed after discovery');
          }
          parentFd = opened.fd;
          parentStat = opened.stat;
          parentLogicalPath = expected.logicalPath;
        }

        assertOpenDirectoryStillBound(
          rootFd,
          discovery.rootStat,
          root,
          discovery.canonicalRoot,
        );
        assertOpenDirectoryStillBound(
          parentFd,
          parentStat,
          parentLogicalPath,
          discovery.canonicalRoot,
        );
        readHooks.beforeRead?.({ assetPath: local.path, root });
        fileFd = api.openat(
          parentFd,
          cString(path.posix.basename(local.path)),
          fs.constants.O_RDONLY
            | fs.constants.O_NOFOLLOW
            | (fs.constants.O_NONBLOCK ?? 0),
          0,
        );
        if (fileFd < 0) {
          throw new Error('secret target is missing, replaced, or a symbolic link');
        }
        const before = fs.fstatSync(fileFd);
        if (
          !before.isFile()
          || before.nlink !== 1
          || !sameFileSnapshot(before, local.stat)
        ) {
          throw new Error('secret target changed after discovery');
        }
        const bytes = fs.readFileSync(fileFd);
        const after = fs.fstatSync(fileFd);
        if (
          !sameFileSnapshot(after, before)
          || bytes.byteLength !== before.size
          || bytes.byteLength > MAX_SECRET_BYTES
        ) {
          throw new Error('secret target changed during secure read');
        }
        assertOpenDirectoryStillBound(
          rootFd,
          discovery.rootStat,
          root,
          discovery.canonicalRoot,
        );
        assertOpenDirectoryStillBound(
          parentFd,
          parentStat,
          parentLogicalPath,
          discovery.canonicalRoot,
        );
        files.push({
          path: local.path,
          content_base64: bytes.toString('base64'),
          asset_type: SECRET_ASSET_TYPE,
          cli: 'shared',
        });
      } finally {
        if (fileFd >= 0) fs.closeSync(fileFd);
        for (const fd of openedDirectories.reverse()) fs.closeSync(fd);
      }
    }
    return files;
  } catch (err) {
    io.stderr(`secrets push failed: secure secret read unavailable: ${err.message}`);
    return null;
  } finally {
    if (rootFd >= 0) fs.closeSync(rootFd);
  }
}

async function restoreSecretFiles(
  root,
  assets,
  {
    force = false,
    dryRun = false,
    restoreHooks = {},
    secureRestoreApi,
  },
  io,
) {
  let rootStat;
  let canonicalRoot;
  try {
    rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error('restore root is not a real directory');
    }
    canonicalRoot = fs.realpathSync(root);
  } catch (err) {
    io.stderr(`secrets pull failed: unsafe restore root: ${err.message}`);
    return { written: 0, skipped: 0, errors: 1 };
  }

  let written = 0;
  let skipped = 0;
  let api;
  let rootFd = -1;
  if (!dryRun) {
    try {
      api = secureRestoreApi ?? await prepareSecureRestore(restoreHooks);
      rootFd = fs.openSync(
        root,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
      );
      if (!sameFileIdentity(fs.fstatSync(rootFd), rootStat)) {
        throw new Error('restore root changed before secure open');
      }
    } catch (err) {
      if (rootFd >= 0) fs.closeSync(rootFd);
      io.stderr(`secrets pull failed: secure restore unavailable: ${err.message}`);
      return { written: 0, skipped: 0, errors: 1 };
    }
  }

  for (const asset of assets) {
    const openedDirectories = [];
    try {
      if (dryRun) {
        if (hasSymlinkWithin(root, asset.path)) {
          throw new Error('destination traverses a symbolic link');
        }
        const destination = path.join(root, asset.path);
        if (fs.existsSync(destination) && !force) {
          skipped += 1;
          continue;
        }
        written += 1;
        continue;
      }

      let parentFd = rootFd;
      let parentLogicalPath = root;
      let parentStat = rootStat;
      const parentSegments = path.posix.dirname(asset.path) === '.'
        ? []
        : path.posix.dirname(asset.path).split('/');
      for (const segment of parentSegments) {
        const opened = openDirectoryAt(api, parentFd, segment, { create: true });
        openedDirectories.push(opened.fd);
        parentFd = opened.fd;
        parentStat = opened.stat;
        parentLogicalPath = path.join(parentLogicalPath, segment);
      }

      assertOpenDirectoryStillBound(rootFd, rootStat, root, canonicalRoot);
      assertOpenDirectoryStillBound(parentFd, parentStat, parentLogicalPath, canonicalRoot);
      const destinationName = path.posix.basename(asset.path);
      const initialDestination = inspectDestinationAt(api, parentFd, destinationName);
      if (initialDestination.exists && !force) {
        skipped += 1;
        continue;
      }

      const nonce = crypto.randomUUID();
      const temporaryName = `.${destinationName}.agentbootup-${nonce}.tmp`;
      const backupName = `.${destinationName}.agentbootup-${nonce}.bak`;
      const temporaryFd = api.openat(
        parentFd,
        cString(temporaryName),
        fs.constants.O_WRONLY
          | fs.constants.O_CREAT
          | fs.constants.O_EXCL
          | fs.constants.O_NOFOLLOW,
        0o600,
      );
      if (temporaryFd < 0) throw new Error('could not create secure restore staging file');
      let temporaryExists = true;
      let backupExists = false;
      let published = false;
      let stagedStat;
      try {
        try {
          fs.writeFileSync(temporaryFd, asset.bytes);
          fs.fchmodSync(temporaryFd, 0o600);
          fs.fsyncSync(temporaryFd);
          stagedStat = fs.fstatSync(temporaryFd);
        } finally {
          fs.closeSync(temporaryFd);
        }

        restoreHooks.beforePublish?.({ assetPath: asset.path, root });
        assertOpenDirectoryStillBound(rootFd, rootStat, root, canonicalRoot);
        assertOpenDirectoryStillBound(parentFd, parentStat, parentLogicalPath, canonicalRoot);

        const currentDestination = inspectDestinationAt(api, parentFd, destinationName);
        if (initialDestination.exists) {
          if (
            !currentDestination.exists
            || !sameFileIdentity(currentDestination.stat, initialDestination.stat)
          ) {
            throw new Error('destination changed during restore');
          }
          if (api.renameat(
            parentFd,
            cString(destinationName),
            parentFd,
            cString(backupName),
          ) !== 0) {
            throw new Error('could not secure the existing destination for rollback');
          }
          backupExists = true;
          const backup = inspectDestinationAt(api, parentFd, backupName);
          if (!backup.exists || !sameFileIdentity(backup.stat, initialDestination.stat)) {
            throw new Error('destination changed while preparing rollback');
          }
        } else if (currentDestination.exists) {
          throw new Error('destination appeared during restore');
        }

        if (api.renameat(
          parentFd,
          cString(temporaryName),
          parentFd,
          cString(destinationName),
        ) !== 0) {
          throw new Error('could not publish secure restore staging file');
        }
        temporaryExists = false;
        published = true;
        const publishedDestination = inspectDestinationAt(api, parentFd, destinationName);
        if (
          !publishedDestination.exists
          || !sameFileIdentity(publishedDestination.stat, stagedStat)
        ) {
          throw new Error('published destination changed during restore');
        }
        assertOpenDirectoryStillBound(rootFd, rootStat, root, canonicalRoot);
        assertOpenDirectoryStillBound(parentFd, parentStat, parentLogicalPath, canonicalRoot);
        if (backupExists) {
          if (api.unlinkat(parentFd, cString(backupName), 0) !== 0) {
            throw new Error('could not remove secure restore rollback file');
          }
          backupExists = false;
        }
      } catch (err) {
        if (published) unlinkAtIfPresent(api, parentFd, destinationName);
        if (backupExists) {
          if (api.renameat(parentFd, cString(backupName), parentFd, cString(destinationName)) !== 0) {
            // Leave the descriptor-relative backup in place for recovery.
            backupExists = false;
            throw new Error(`${err.message}; rollback of the original destination failed`);
          }
          backupExists = false;
        }
        throw err;
      } finally {
        if (temporaryExists) unlinkAtIfPresent(api, parentFd, temporaryName);
        if (backupExists) unlinkAtIfPresent(api, parentFd, backupName);
      }
      written += 1;
    } catch (err) {
      io.stderr(`secrets pull failed: could not restore ${asset.path}: ${err.message}`);
      if (rootFd >= 0) fs.closeSync(rootFd);
      return { written, skipped, errors: 1 };
    } finally {
      for (const fd of openedDirectories.reverse()) fs.closeSync(fd);
    }
  }
  if (rootFd >= 0) fs.closeSync(rootFd);
  return { written, skipped, errors: 0 };
}

/**
 * Parse a TTL string into seconds. Accepts: 30m, 1h, 24h, 7d, or a bare number (seconds).
 * @param {string} value
 * @returns {{ ok: true, seconds: number } | { ok: false, error: string }}
 */
export function parseTtlToSeconds(value) {
  if (value == null || String(value).trim() === '') {
    return { ok: false, error: 'TTL value is required' };
  }
  const s = String(value).trim().toLowerCase();
  const match = s.match(/^(\d+)\s*(s|m|h|d)?$/);
  if (!match) {
    return { ok: false, error: `Invalid TTL: "${value}". Use a number with optional suffix: s, m, h, d (e.g. 24h, 7d)` };
  }
  let num = parseInt(match[1], 10);
  if (!Number.isFinite(num) || num <= 0) {
    return { ok: false, error: 'TTL must be a positive number' };
  }
  const suffix = match[2] || 's';
  switch (suffix) {
    case 's': break;
    case 'm': num *= 60; break;
    case 'h': num *= 3600; break;
    case 'd': num *= 86400; break;
    default: return { ok: false, error: `Invalid TTL suffix: ${suffix}` };
  }
  if (num < SECRET_TTL_MIN_SECONDS) {
    return { ok: false, error: `TTL must be at least ${SECRET_TTL_MIN_SECONDS} seconds (1 minute)` };
  }
  if (num > SECRET_TTL_MAX_SECONDS) {
    return { ok: false, error: `TTL must be at most ${SECRET_TTL_MAX_SECONDS} seconds (30 days)` };
  }
  return { ok: true, seconds: num };
}


export function printUsage(io) {
  io.stdout('Usage: agentbootup secrets push [--dry-run] [--cwd <path>] [--ttl <duration>]');
  io.stdout('       agentbootup secrets pull [--force] [--dry-run] [--cwd <path>]');
  io.stdout('');
  io.stdout('Syncs allowlisted secret files (.env, .dev.vars, brain/config.secret.json) to/from the server.');
  io.stdout('Manual only — the daemon never syncs secrets.');
  io.stdout('');
  io.stdout('  --ttl <duration>  (push only) Request server to expire pushed secrets after this duration.');
  io.stdout('                    Examples: 24h, 7d, 3600. Min 60s, max 30d. Optional; if omitted, no TTL.');
}

/**
 * Push local secret files to the server.
 * @param {string} cwd - Project root (must contain brain/config.json)
 * @param {{ stdout: (s: string) => void, stderr: (s: string) => void }} io
 * @param {{ dryRun?: boolean, ttlSeconds?: number, expectedServerUrl?: string, readHooks?: object, readCredentialsImpl?: () => Promise<{apiKey: string, serverUrl: string} | null> }} opts
 * @returns {Promise<number>} exit code
 */
export async function runSecretsPush(cwd, io, opts = {}) {
  if (typeof globalThis.Bun === 'undefined' && !opts.dryRun) {
    return delegateSecretsPushToBun(cwd, io, opts);
  }
  const resolvedCwd = path.resolve(cwd);
  const brainId = resolveSecretsBrainId(resolvedCwd, io, 'secrets push');
  if (!brainId) return 1;

  const creds = await resolveCommandCredentials(opts);
  if (!creds?.apiKey || !creds?.serverUrl) {
    io.stderr('secrets push failed: no credentials — run: agentbootup auth login');
    return 1;
  }
  if (!isValidServerUrl(creds.serverUrl)) {
    io.stderr(`secrets push failed: invalid server URL in credentials: ${creds.serverUrl}`);
    return 1;
  }
  if (opts.expectedServerUrl && creds.serverUrl.replace(/\/$/, '') !== opts.expectedServerUrl.replace(/\/$/, '')) {
    io.stderr('secrets push failed: authenticated server does not match the explicitly approved deployed target');
    return 1;
  }

  const discovery = discoverLocalSecretFiles(resolvedCwd, io);
  if (discovery === null) return 1;
  const localFiles = discovery.files;

  const compatible = await preflightSecretContract(
    {
      serverUrl: creds.serverUrl,
      apiKey: creds.apiKey,
      brainId,
      localFiles,
      ttlSeconds: opts.ttlSeconds,
    },
    io,
    'secrets push',
  );
  if (!compatible) return 1;

  if (localFiles.length === 0) {
    io.stdout('No secret files found to push (.env, .dev.vars, brain/config.secret.json).');
    return 0;
  }

  if (opts.dryRun) {
    io.stdout(`Secrets push (dry-run): ${brainId} → ${creds.serverUrl}`);
    io.stdout('  Server contract preflight: accepted');
    io.stdout(`  Discovered ${localFiles.length} candidate file(s):`);
    for (const f of localFiles) io.stdout(`    ${f.path}`);
    io.stdout('  Secret bytes were not securely opened or transmitted; a real push may still fail secure-read checks.');
    if (opts.ttlSeconds) io.stdout(`  TTL: ${opts.ttlSeconds}s`);
    return 0;
  }

  const files = await readLocalSecretFilesSecurely(
    resolvedCwd,
    discovery,
    opts.readHooks ?? {},
    io,
  );
  if (files === null) return 1;

  io.stdout(`Secrets push: ${brainId} → ${creds.serverUrl}`);
  io.stdout(`  Pushing ${files.length} file(s)...`);
  if (opts.ttlSeconds) io.stdout(`  TTL: ${opts.ttlSeconds}s`);

  const payload = { files };
  if (opts.ttlSeconds != null) payload.ttl_seconds = opts.ttlSeconds;

  const endpoint = apiUrl(creds.serverUrl, `/v1/brain-assets/${encodeURIComponent(brainId)}/push`);
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: brainAssetPushHeaders(creds.apiKey),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timerId);

    if (!resp.ok) {
      if (resp.status === 404) {
        io.stderr(`secrets push failed: brain "${brainId}" is not provisioned on the agentbootup server.`);
        io.stderr(`Run the provisioning/registration step for this brain, then retry: agentbootup provision --agent ${brainId} --type <type> --repo <path>`);
        return 1;
      }
      io.stderr(`secrets push failed: HTTP ${resp.status}`);
      return 1;
    }
    let responsePayload;
    try {
      responsePayload = await resp.json();
    } catch {
      io.stderr('secrets push failed: server returned malformed JSON');
      return 1;
    }
    const result = responsePayload?.data;
    const responseResults = result?.results;
    const expectedPaths = new Set(files.map((file) => file.path));
    const validResults = Array.isArray(responseResults)
      && responseResults.length === files.length
      && responseResults.every((entry) =>
        entry
        && typeof entry === 'object'
        && expectedPaths.delete(entry.path)
        && (entry.status === 'pushed' || entry.status === 'updated'))
      && expectedPaths.size === 0;
    if (
      !validResults
      || !Number.isSafeInteger(result?.pushed)
      || !Number.isSafeInteger(result?.updated)
      || result?.errors !== 0
      || result.pushed + result.updated !== files.length
    ) {
      io.stderr('secrets push failed: server did not atomically accept the complete secret batch');
      return 1;
    }
    io.stdout(`  Pushed ${files.length} file(s).`);
    return 0;
  } catch (err) {
    clearTimeout(timerId);
    if (err.name === 'AbortError') {
      io.stderr('secrets push failed: request timed out');
    } else {
      io.stderr(`secrets push failed: ${err.message}`);
    }
    return 1;
  }
}

/**
 * Pull secret files from the server into the project.
 * @param {string} cwd - Project root (must contain brain/config.json)
 * @param {{ stdout: (s: string) => void, stderr: (s: string) => void }} io
 * @param {{ force?: boolean, dryRun?: boolean, expectedServerUrl?: string, readCredentialsImpl?: () => Promise<{apiKey: string, serverUrl: string} | null> }} opts
 * @returns {Promise<number>} exit code
 */
export async function runSecretsPull(cwd, io, opts = {}) {
  if (typeof globalThis.Bun === 'undefined') {
    return delegateSecretsPullToBun(cwd, io, opts);
  }
  const resolvedCwd = path.resolve(cwd);
  const brainId = resolveSecretsBrainId(resolvedCwd, io, 'secrets pull');
  if (!brainId) return 1;

  const creds = await resolveCommandCredentials(opts);
  if (!creds?.apiKey || !creds?.serverUrl) {
    io.stderr('secrets pull failed: no credentials — run: agentbootup auth login');
    return 1;
  }
  if (!isValidServerUrl(creds.serverUrl)) {
    io.stderr(`secrets pull failed: invalid server URL in credentials: ${creds.serverUrl}`);
    return 1;
  }
  if (opts.expectedServerUrl && creds.serverUrl.replace(/\/$/, '') !== opts.expectedServerUrl.replace(/\/$/, '')) {
    io.stderr('secrets pull failed: authenticated server does not match the explicitly approved deployed target');
    return 1;
  }

  const compatible = await preflightSecretContract(
    {
      serverUrl: creds.serverUrl,
      apiKey: creds.apiKey,
      brainId,
      requireRestore: true,
    },
    io,
    'secrets pull',
  );
  if (!compatible) return 1;

  if (opts.dryRun) {
    io.stdout(`Secrets pull (dry-run): ${brainId} → ${resolvedCwd}`);
    io.stdout('  Server contract preflight: accepted');
    io.stdout('  No secret payload was requested and no local files were changed.');
    return 0;
  }

  let secureRestoreApi;
  try {
    secureRestoreApi = await prepareSecureRestore(opts.restoreHooks);
  } catch (err) {
    io.stderr(`secrets pull failed: secure restore unavailable: ${err.message}`);
    return 1;
  }

  const endpoint = apiUrl(
    creds.serverUrl,
    `/v1/brain-assets/${encodeURIComponent(brainId)}?asset_type=${SECRET_ASSET_TYPE}`,
  );
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'GET',
      headers: brainAssetPushHeaders(creds.apiKey),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
  } catch (err) {
    io.stderr(`secrets pull failed: ${err?.name === 'TimeoutError' ? 'request timed out' : err.message}`);
    return 1;
  }
  if (!response.ok) {
    io.stderr(`secrets pull failed: HTTP ${response.status}`);
    return 1;
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    io.stderr('secrets pull failed: server returned malformed JSON');
    return 1;
  }
  const assets = parseSecretPullResponse(payload, io);
  if (assets === null) return 1;
  const result = await restoreSecretFiles(
    resolvedCwd,
    assets,
    { ...opts, secureRestoreApi },
    io,
  );
  if (result.errors > 0) return 1;
  io.stdout(`Secrets pull: restored=${result.written} skipped=${result.skipped}`);
  return 0;
}

export async function runSecretsCleanup(cwd, io, opts = {}) {
  const resolvedCwd = path.resolve(cwd);
  const brainId = resolveSecretsBrainId(resolvedCwd, io, 'secrets cleanup');
  if (!brainId) return 1;
  if (opts.confirmBrainId !== brainId) {
    io.stderr(`secrets cleanup failed: exact brain confirmation is required (confirmBrainId=${brainId})`);
    return 1;
  }
  const creds = await resolveCommandCredentials(opts);
  if (!creds?.apiKey || !creds?.serverUrl || !isValidServerUrl(creds.serverUrl)) {
    io.stderr('secrets cleanup failed: valid credentials are required');
    return 1;
  }
  if (opts.expectedServerUrl && creds.serverUrl.replace(/\/$/, '') !== opts.expectedServerUrl.replace(/\/$/, '')) {
    io.stderr('secrets cleanup failed: authenticated server does not match the explicitly approved deployed target');
    return 1;
  }
  const compatible = await preflightSecretContract(
    { serverUrl: creds.serverUrl, apiKey: creds.apiKey, brainId },
    io,
    'secrets cleanup',
  );
  if (!compatible) return 1;
  const endpoint = apiUrl(
    creds.serverUrl,
    `/v1/brain-assets/${encodeURIComponent(brainId)}?asset_type=${SECRET_ASSET_TYPE}&confirm_brain_id=${encodeURIComponent(brainId)}`,
  );
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'DELETE',
      headers: brainAssetPushHeaders(creds.apiKey),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
  } catch (err) {
    io.stderr(`secrets cleanup failed: ${err?.name === 'TimeoutError' ? 'request timed out' : err.message}`);
    return 1;
  }
  if (!response.ok) {
    io.stderr(`secrets cleanup failed: HTTP ${response.status}`);
    return 1;
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    io.stderr('secrets cleanup failed: server returned malformed JSON');
    return 1;
  }
  if (
    !Number.isSafeInteger(payload?.data?.deleted)
    || payload?.data?.deleted < 1
    || payload?.data?.errors !== 0
    || payload?.data?.remaining !== 0
    || payload?.data?.verified_absent !== true
  ) {
    io.stderr('secrets cleanup failed: server returned an invalid cleanup result');
    return 1;
  }
  io.stdout(`Secrets cleanup: removed=${payload.data.deleted}`);
  return 0;
}
