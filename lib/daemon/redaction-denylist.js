import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { withFileLock, withFileLockSync } from '../util/file-lock.js';

const DEFAULT_MIN_VALUE_LENGTH = 12;
const DEFAULT_MAX_SOURCE_VALUES = 500;
const DEFAULT_POLL_MS = 60_000;
const DEFAULT_DEBOUNCE_MS = 2_000;
const DEFAULT_MAX_EXPLICIT_BYTES = 16 * 1024 * 1024;
const DEFAULT_AGENTBOOTUP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXPLICIT_BASE64_PREFIX = 'base64-v1:';
const EXPLICIT_RECORD_MARKER_PREFIX = '# agentbootup-record-v1:';
export const REDACT_DENYLIST_LOCK_OPTIONS = Object.freeze({ staleMs: 60_000, waitMs: 125_000 });
const execFileAsync = promisify(execFile);

function attachExplicitSourceRecords(values, sourceRecords) {
  Object.defineProperty(values, 'sourceRecords', {
    value: new Set(sourceRecords), enumerable: false, configurable: false, writable: false,
  });
  return values;
}

function decodeUtf8Strict(input, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch {
    throw new SyntaxError(`${label} must contain valid UTF-8 text`);
  }
}

function positiveInteger(value, fallback, name) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return parsed;
}

export function explicitDenylistMaxBytes(options = {}) {
  const environment = options.environment ?? process.env;
  return positiveInteger(
    options.maxExplicitBytes ?? environment.AGENTBOOTUP_REDACT_DENYLIST_MAX_BYTES,
    DEFAULT_MAX_EXPLICIT_BYTES,
    'AGENTBOOTUP_REDACT_DENYLIST_MAX_BYTES',
  );
}

function expandVariables(value, resolveVariable) {
  const escaped = [];
  const protectedValue = value.replace(
    /\\(\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*))/g,
    (_match, token) => {
      const marker = `\u0000agentbootup-escaped-${escaped.length}\u0000`;
      escaped.push([marker, token]);
      return marker;
    },
  );
  let expanded = protectedValue.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (_match, braced, plain) => resolveVariable(braced ?? plain),
  );
  for (const [marker, token] of escaped) expanded = expanded.replaceAll(marker, token);
  return expanded;
}

function unescapeDoubleQuoted(value) {
  return value.replace(/\\(n|r|t|\\|")/g, (_match, escaped) => ({
    n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"',
  })[escaped]);
}

function findClosingQuote(value, quote) {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] !== quote) continue;
    if (quote === "'" || value[index - 1] !== '\\') return index;
    let slashCount = 0;
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) slashCount += 1;
    if (slashCount % 2 === 0) return index;
  }
  return -1;
}

/** Parse dotenv text using Bun-compatible final-value expansion semantics. */
export function parseDotEnv(text, { environment = process.env } = {}) {
  if (typeof text !== 'string') throw new TypeError('dotenv input must be a string');
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const entries = {};

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    let line = lines[lineIndex].trimStart();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trimStart();
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key] = match;
    let raw = match[2];
    const quote = raw[0] === '"' || raw[0] === "'" || raw[0] === '`' ? raw[0] : null;
    let value;

    if (quote) {
      let closing = findClosingQuote(raw, quote);
      while (closing === -1 && lineIndex + 1 < lines.length) {
        lineIndex += 1;
        raw += `\n${lines[lineIndex]}`;
        closing = findClosingQuote(raw, quote);
      }
      if (closing === -1) throw new SyntaxError(`unterminated quoted dotenv value for ${key}`);
      value = raw.slice(1, closing);
      if (quote === '"' || quote === '`') value = unescapeDoubleQuoted(value);
    } else {
      const comment = raw.indexOf('#');
      value = (comment === -1 ? raw : raw.slice(0, comment)).trim();
    }

    entries[key] = { value, expand: true };
  }

  const parsed = {};
  const resolving = new Set();
  const resolveVariable = (key) => {
    if (Object.prototype.hasOwnProperty.call(environment, key)) return String(environment[key] ?? '');
    if (Object.prototype.hasOwnProperty.call(parsed, key)) return parsed[key];
    const entry = entries[key];
    if (!entry || resolving.has(key)) return '';
    resolving.add(key);
    const resolved = entry.expand ? expandVariables(entry.value, resolveVariable) : entry.value;
    resolving.delete(key);
    parsed[key] = resolved;
    return resolved;
  };
  for (const key of Object.keys(entries)) parsed[key] = resolveVariable(key);
  return parsed;
}

function collectValues(entries, minLength) {
  return new Set(Object.values(entries).filter((value) => typeof value === 'string' && value.length >= minLength));
}

function validateDirectoryChainSync(
  directoryPath,
  fsImpl,
  label,
  { allowMissing = false, enforceTrustedAncestors = false } = {},
) {
  const expectedUid = process.getuid?.();
  const resolved = path.resolve(directoryPath);
  const parsed = path.parse(resolved);
  let cursor = parsed.root;
  for (const component of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    let stat;
    try {
      stat = fsImpl.lstatSync(cursor);
    } catch (error) {
      if (allowMissing && error?.code === 'ENOENT') return false;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new TypeError(`${label} must contain only regular non-symlink directories`);
    }
    const mode = stat.mode & 0o7777;
    if (enforceTrustedAncestors
      && Number.isSafeInteger(expectedUid) && stat.uid !== expectedUid && stat.uid !== 0) {
      throw new Error(`${label} ancestor must be owned by the current operating account or root`);
    }
    if (enforceTrustedAncestors && (mode & 0o022) !== 0 && (mode & 0o1000) === 0) {
      throw new Error(`${label} ancestor must not be writable by group or other`);
    }
  }
  return true;
}

async function validateDirectoryChain(
  directoryPath,
  fspImpl,
  label,
  { allowMissing = false, enforceTrustedAncestors = false } = {},
) {
  const expectedUid = process.getuid?.();
  const resolved = path.resolve(directoryPath);
  const parsed = path.parse(resolved);
  let cursor = parsed.root;
  for (const component of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    let stat;
    try {
      stat = await fspImpl.lstat(cursor);
    } catch (error) {
      if (allowMissing && error?.code === 'ENOENT') return false;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new TypeError(`${label} must contain only regular non-symlink directories`);
    }
    const mode = stat.mode & 0o7777;
    if (enforceTrustedAncestors
      && Number.isSafeInteger(expectedUid) && stat.uid !== expectedUid && stat.uid !== 0) {
      throw new Error(`${label} ancestor must be owned by the current operating account or root`);
    }
    if (enforceTrustedAncestors && (mode & 0o022) !== 0 && (mode & 0o1000) === 0) {
      throw new Error(`${label} ancestor must not be writable by group or other`);
    }
  }
  return true;
}

function assertDenylistPlatformSupported(options = {}) {
  if ((options.platform ?? process.platform) === 'win32') {
    const error = new Error('transcript redaction denylist loading is unsupported on Windows until ACL validation is available');
    error.code = 'redaction_denylist_platform_unsupported';
    throw error;
  }
}

export function assertOwnerOnlyPath(filePath, stat, options = {}) {
  const expectedUid = options.expectedUid ?? process.getuid?.();
  if (Number.isSafeInteger(expectedUid) && stat.uid !== expectedUid) {
    throw new Error(`${options.label ?? 'protected path'} must be owned by the current operating account`);
  }
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const existsSyncImpl = options.existsSyncImpl ?? fs.existsSync;
  const inspectorPath = options.aclInspectorPath ?? [
    ...(process.platform === 'darwin' ? ['/bin/ls', '/usr/bin/ls'] : ['/usr/bin/ls', '/bin/ls']),
    '/run/current-system/sw/bin/ls',
    '/nix/var/nix/profiles/default/bin/ls',
  ].find((candidate) => existsSyncImpl(candidate));
  if (!inspectorPath) {
    throw new Error(`${options.label ?? 'protected path'} ACL validation tool is unavailable; refusing to continue`);
  }
  const inspection = spawnSyncImpl(inspectorPath, ['-ld', filePath], {
    encoding: 'utf8', timeout: 5_000, maxBuffer: 8_192,
  });
  if (inspection.error || inspection.status !== 0) {
    throw new Error(`${options.label ?? 'protected path'} ACL validation failed closed`);
  }
  const modeToken = inspection.stdout.trimStart().split(/\s+/, 1)[0];
  if (!/^[bcdlps-][rwxStTs-]{9}[@.]?$/.test(modeToken)) {
    if (modeToken.includes('+')) {
      throw new Error(`${options.label ?? 'protected path'} must not grant access through an extended ACL`);
    }
    throw new Error(`${options.label ?? 'protected path'} ACL validation returned an unrecognized mode`);
  }
}

async function assertOwnerOnlyPathAsync(filePath, stat, options = {}) {
  const label = options.label ?? 'protected path';
  const expectedUid = options.expectedUid ?? process.getuid?.();
  if (Number.isSafeInteger(expectedUid) && stat.uid !== expectedUid) {
    throw new Error(`${label} must be owned by the current operating account`);
  }
  const fspImpl = options.fspImpl ?? fsp;
  const candidates = options.aclInspectorPath ? [options.aclInspectorPath] : [
    ...(process.platform === 'darwin' ? ['/bin/ls', '/usr/bin/ls'] : ['/usr/bin/ls', '/bin/ls']),
    '/run/current-system/sw/bin/ls',
    '/nix/var/nix/profiles/default/bin/ls',
  ];
  let inspectorPath = null;
  for (const candidate of candidates) {
    try {
      await fspImpl.access(candidate);
      inspectorPath = candidate;
      break;
    } catch { /* try the next trusted platform path */ }
  }
  if (!inspectorPath) throw new Error(`${label} ACL validation tool is unavailable; refusing to continue`);
  let inspection;
  try {
    const execFileAsyncImpl = options.execFileAsyncImpl ?? execFileAsync;
    inspection = await execFileAsyncImpl(inspectorPath, ['-ld', filePath], {
      encoding: 'utf8', timeout: 5_000, maxBuffer: 8_192,
    });
  } catch {
    throw new Error(`${label} ACL validation failed closed`);
  }
  const modeToken = inspection.stdout.trimStart().split(/\s+/, 1)[0];
  if (!/^[bcdlps-][rwxStTs-]{9}[@.]?$/.test(modeToken)) {
    if (modeToken.includes('+')) throw new Error(`${label} must not grant access through an extended ACL`);
    throw new Error(`${label} ACL validation returned an unrecognized mode`);
  }
}

export function loadEnvDenylist(projectRoots, options = {}) {
  if (!Array.isArray(projectRoots)) throw new TypeError('projectRoots must be an array');
  const fsImpl = options.fsImpl ?? fs;
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    const error = new Error('transcript redaction denylist loading is unsupported on Windows until ACL validation is available');
    error.code = 'redaction_denylist_platform_unsupported';
    throw error;
  }
  const environment = options.environment ?? process.env;
  const minLength = positiveInteger(
    options.minLength ?? environment.AGENTBOOTUP_REDACT_MIN_VALUE_LEN,
    DEFAULT_MIN_VALUE_LENGTH,
    'AGENTBOOTUP_REDACT_MIN_VALUE_LEN',
  );
  const values = new Set();
  const agentbootupRoot = options.agentbootupRoot === undefined ? DEFAULT_AGENTBOOTUP_ROOT : options.agentbootupRoot;
  const roots = [...projectRoots, ...(agentbootupRoot ? [agentbootupRoot] : [])];
  for (const root of new Set(roots.map((entry) => path.resolve(entry)))) {
    if (!validateDirectoryChainSync(root, fsImpl, 'configured project root', { allowMissing: true })) continue;
    const envPath = path.join(root, '.env');
    let descriptor;
    let text;
    try {
      const leafStat = fsImpl.lstatSync(envPath);
      if (leafStat.isSymbolicLink() || !leafStat.isFile()) {
        throw new TypeError('project .env must be a regular non-symlink file');
      }
      if (leafStat.nlink !== 1) throw new TypeError('project .env must not be hard linked');
      descriptor = fsImpl.openSync(envPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    try {
      const stat = fsImpl.fstatSync(descriptor);
      if (!stat.isFile()) throw new TypeError('project .env must be a regular non-symlink file');
      if (stat.nlink !== 1) throw new TypeError('project .env must not be hard linked');
      text = decodeUtf8Strict(fsImpl.readFileSync(descriptor), 'project .env');
    } finally {
      fsImpl.closeSync(descriptor);
    }
    const fileResolved = parseDotEnv(text, { environment: {} });
    // Bun gives ambient variables precedence over assignments. Preserve that
    // effective view only for names the file itself declares; allowing an
    // arbitrary `$PATH`-style reference to import unrelated daemon state would
    // expand the PRD's deliberately narrow source boundary beyond this file.
    const declaredEnvironment = {};
    for (const key of Object.keys(fileResolved)) {
      if (Object.hasOwn(environment, key)) declaredEnvironment[key] = environment[key];
    }
    for (const parsed of [parseDotEnv(text, { environment: declaredEnvironment }), fileResolved]) {
      for (const value of collectValues(parsed, minLength)) values.add(value);
    }
  }
  return values;
}

export async function loadEnvDenylistAsync(projectRoots, options = {}) {
  if (!Array.isArray(projectRoots)) throw new TypeError('projectRoots must be an array');
  assertDenylistPlatformSupported(options);
  const fspImpl = options.fspImpl ?? fsp;
  const environment = options.environment ?? process.env;
  const minLength = positiveInteger(
    options.minLength ?? environment.AGENTBOOTUP_REDACT_MIN_VALUE_LEN,
    DEFAULT_MIN_VALUE_LENGTH,
    'AGENTBOOTUP_REDACT_MIN_VALUE_LEN',
  );
  const values = new Set();
  const agentbootupRoot = options.agentbootupRoot === undefined ? DEFAULT_AGENTBOOTUP_ROOT : options.agentbootupRoot;
  const roots = [...projectRoots, ...(agentbootupRoot ? [agentbootupRoot] : [])];
  for (const root of new Set(roots.map((entry) => path.resolve(entry)))) {
    if (!await validateDirectoryChain(root, fspImpl, 'configured project root', { allowMissing: true })) continue;
    const envPath = path.join(root, '.env');
    let handle;
    let text;
    try {
      const leafStat = await fspImpl.lstat(envPath);
      if (leafStat.isSymbolicLink() || !leafStat.isFile()) {
        throw new TypeError('project .env must be a regular non-symlink file');
      }
      if (leafStat.nlink !== 1) throw new TypeError('project .env must not be hard linked');
      handle = await fspImpl.open(envPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new TypeError('project .env must be a regular non-symlink file');
      if (stat.nlink !== 1) throw new TypeError('project .env must not be hard linked');
      text = decodeUtf8Strict(await handle.readFile(), 'project .env');
    } finally {
      await handle.close();
    }
    const fileResolved = parseDotEnv(text, { environment: {} });
    const declaredEnvironment = {};
    for (const key of Object.keys(fileResolved)) {
      if (Object.hasOwn(environment, key)) declaredEnvironment[key] = environment[key];
    }
    for (const parsed of [parseDotEnv(text, { environment: declaredEnvironment }), fileResolved]) {
      for (const value of collectValues(parsed, minLength)) values.add(value);
    }
  }
  return values;
}

function parseExplicitDenylistText(text) {
  const values = new Set();
  const sourceRecords = new Set();
  let expectedRecordHash = null;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const classification = line.trim();
    if (line.startsWith(EXPLICIT_RECORD_MARKER_PREFIX)) {
      if (expectedRecordHash !== null) {
        const error = new Error('redact-denylist contains a nested framed record');
        error.code = 'redaction_denylist_record_invalid';
        throw error;
      }
      const hash = line.slice(EXPLICIT_RECORD_MARKER_PREFIX.length);
      if (!/^[a-f0-9]{64}$/.test(hash)) {
        const error = new Error('redact-denylist contains a malformed record marker');
        error.code = 'redaction_denylist_record_invalid';
        throw error;
      }
      expectedRecordHash = hash;
      continue;
    }
    if (expectedRecordHash !== null) {
      if (!line.startsWith(EXPLICIT_BASE64_PREFIX)) {
        const error = new Error('redact-denylist framed record is missing its tagged value');
        error.code = 'redaction_denylist_record_invalid';
        throw error;
      }
      const encoded = line.slice(EXPLICIT_BASE64_PREFIX.length);
      if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        const error = new Error('redact-denylist contains a malformed tagged record');
        error.code = 'redaction_denylist_record_invalid';
        throw error;
      }
      const decoded = Buffer.from(encoded, 'base64');
      if (decoded.toString('base64') !== encoded) {
        const error = new Error('redact-denylist contains a non-canonical tagged record');
        error.code = 'redaction_denylist_record_invalid';
        throw error;
      }
      if (createHash('sha256').update(decoded).digest('hex') !== expectedRecordHash) {
        const error = new Error('redact-denylist framed record checksum mismatch');
        error.code = 'redaction_denylist_record_invalid';
        throw error;
      }
      let decodedText;
      try { decodedText = decodeUtf8Strict(decoded, 'redact-denylist tagged record'); }
      catch {
        const error = new Error('redact-denylist framed record must decode to valid UTF-8');
        error.code = 'redaction_denylist_record_invalid';
        throw error;
      }
      values.add(decodedText);
      sourceRecords.add(decodedText);
      expectedRecordHash = null;
      continue;
    }
    if (!classification || classification.startsWith('#')) continue;
    values.add(line);
    sourceRecords.add(line);
  }
  if (expectedRecordHash !== null) {
    const error = new Error('redact-denylist contains a truncated framed record');
    error.code = 'redaction_denylist_record_invalid';
    throw error;
  }
  return attachExplicitSourceRecords(values, sourceRecords);
}

export function loadExplicitDenylist(options = {}) {
  const fsImpl = options.fsImpl ?? fs;
  assertDenylistPlatformSupported(options);
  const filePath = options.filePath ?? path.join(os.homedir(), '.agentbootup', 'redact-denylist');
  const maxBytes = explicitDenylistMaxBytes(options);
  const parent = path.dirname(filePath);
  try {
    if (!validateDirectoryChainSync(parent, fsImpl, 'redact-denylist parent', {
      allowMissing: true,
      enforceTrustedAncestors: true,
    })) {
      return attachExplicitSourceRecords(new Set(), new Set());
    }
    const parentStat = fsImpl.lstatSync(parent);
    assertOwnerOnlyPath(parent, parentStat, {
      expectedUid: options.expectedUid,
      spawnSyncImpl: options.spawnSyncImpl,
      existsSyncImpl: options.existsSyncImpl,
      aclInspectorPath: options.aclInspectorPath,
      label: 'redact-denylist parent',
    });
    if ((parentStat.mode & 0o777) !== 0o700) {
      throw new Error('redact-denylist parent permissions must be exactly 0700');
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return attachExplicitSourceRecords(new Set(), new Set());
    throw error;
  }
  const readLockedFile = () => {
    let descriptor;
    try {
      const leafStat = fsImpl.lstatSync(filePath);
      if (leafStat.isSymbolicLink() || !leafStat.isFile()) {
        throw new TypeError('redact-denylist must be a regular non-symlink file');
      }
      if (leafStat.nlink !== 1) throw new TypeError('redact-denylist must not be hard linked');
      descriptor = fsImpl.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (error) {
      if (error?.code === 'ENOENT') return attachExplicitSourceRecords(new Set(), new Set());
      throw error;
    }
    try {
      const stat = fsImpl.fstatSync(descriptor);
      if (!stat.isFile()) throw new TypeError('redact-denylist must be a regular file');
      if (stat.nlink !== 1) throw new TypeError('redact-denylist must not be hard linked');
      assertOwnerOnlyPath(filePath, stat, {
        expectedUid: options.expectedUid,
        spawnSyncImpl: options.spawnSyncImpl,
        existsSyncImpl: options.existsSyncImpl,
        aclInspectorPath: options.aclInspectorPath,
        label: 'redact-denylist',
      });
      if ((stat.mode & 0o777) !== 0o600) {
        throw new Error('redact-denylist permissions must be exactly 0600');
      }
      if (stat.size > maxBytes) {
        const error = new Error('redact-denylist exceeds AGENTBOOTUP_REDACT_DENYLIST_MAX_BYTES');
        error.code = 'redaction_denylist_file_too_large';
        throw error;
      }
      const values = new Set();
      const sourceRecords = new Set();
      const text = decodeUtf8Strict(fsImpl.readFileSync(descriptor), 'redact-denylist');
      let expectedRecordHash = null;
      for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
        const classification = line.trim();
        if (line.startsWith(EXPLICIT_RECORD_MARKER_PREFIX)) {
          if (expectedRecordHash !== null) {
            const error = new Error('redact-denylist contains a nested framed record');
            error.code = 'redaction_denylist_record_invalid';
            throw error;
          }
          const hash = line.slice(EXPLICIT_RECORD_MARKER_PREFIX.length);
          if (!/^[a-f0-9]{64}$/.test(hash)) {
            const error = new Error('redact-denylist contains a malformed record marker');
            error.code = 'redaction_denylist_record_invalid';
            throw error;
          }
          expectedRecordHash = hash;
          continue;
        }
        if (expectedRecordHash !== null) {
          if (!line.startsWith(EXPLICIT_BASE64_PREFIX)) {
            const error = new Error('redact-denylist framed record is missing its tagged value');
            error.code = 'redaction_denylist_record_invalid';
            throw error;
          }
          const encoded = line.slice(EXPLICIT_BASE64_PREFIX.length);
          if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
            const error = new Error('redact-denylist contains a malformed tagged record');
            error.code = 'redaction_denylist_record_invalid';
            throw error;
          }
          const decoded = Buffer.from(encoded, 'base64');
          if (decoded.toString('base64') !== encoded) {
            const error = new Error('redact-denylist contains a non-canonical tagged record');
            error.code = 'redaction_denylist_record_invalid';
            throw error;
          }
          const actualHash = createHash('sha256').update(decoded).digest('hex');
          if (actualHash !== expectedRecordHash) {
            const error = new Error('redact-denylist framed record checksum mismatch');
            error.code = 'redaction_denylist_record_invalid';
            throw error;
          }
          let decodedText;
          try {
            decodedText = decodeUtf8Strict(decoded, 'redact-denylist tagged record');
          } catch {
            const error = new Error('redact-denylist framed record must decode to valid UTF-8');
            error.code = 'redaction_denylist_record_invalid';
            throw error;
          }
          values.add(decodedText);
          sourceRecords.add(decodedText);
          expectedRecordHash = null;
          continue;
        }
        if (!classification || classification.startsWith('#')) continue;
        values.add(line);
        sourceRecords.add(line);
      }
      if (expectedRecordHash !== null) {
        const error = new Error('redact-denylist contains a truncated framed record');
        error.code = 'redaction_denylist_record_invalid';
        throw error;
      }
      return attachExplicitSourceRecords(values, sourceRecords);
    } finally {
      fsImpl.closeSync(descriptor);
    }
  };
  if (options.lockAlreadyHeld) return readLockedFile();
  return withFileLockSync(filePath, readLockedFile, { ...REDACT_DENYLIST_LOCK_OPTIONS, fsImpl });
}

export async function loadExplicitDenylistAsync(options = {}) {
  assertDenylistPlatformSupported(options);
  const fspImpl = options.fspImpl ?? fsp;
  const filePath = options.filePath ?? path.join(os.homedir(), '.agentbootup', 'redact-denylist');
  const parent = path.dirname(filePath);
  const maxBytes = explicitDenylistMaxBytes(options);
  try {
    if (!await validateDirectoryChain(parent, fspImpl, 'redact-denylist parent', {
      allowMissing: true,
      enforceTrustedAncestors: true,
    })) {
      return attachExplicitSourceRecords(new Set(), new Set());
    }
    const parentStat = await fspImpl.lstat(parent);
    await assertOwnerOnlyPathAsync(parent, parentStat, {
      expectedUid: options.expectedUid,
      fspImpl,
      execFileAsyncImpl: options.execFileAsyncImpl,
      aclInspectorPath: options.aclInspectorPath,
      label: 'redact-denylist parent',
    });
    if ((parentStat.mode & 0o777) !== 0o700) {
      throw new Error('redact-denylist parent permissions must be exactly 0700');
    }
    return await withFileLock(
      filePath,
      async () => {
        let handle;
        try {
          const leafStat = await fspImpl.lstat(filePath);
          if (leafStat.isSymbolicLink() || !leafStat.isFile()) {
            throw new TypeError('redact-denylist must be a regular non-symlink file');
          }
          if (leafStat.nlink !== 1) throw new TypeError('redact-denylist must not be hard linked');
          handle = await fspImpl.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        } catch (error) {
          if (error?.code === 'ENOENT') return attachExplicitSourceRecords(new Set(), new Set());
          throw error;
        }
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) throw new TypeError('redact-denylist must be a regular file');
          if (stat.nlink !== 1) throw new TypeError('redact-denylist must not be hard linked');
          await assertOwnerOnlyPathAsync(filePath, stat, {
            expectedUid: options.expectedUid,
            fspImpl,
            execFileAsyncImpl: options.execFileAsyncImpl,
            aclInspectorPath: options.aclInspectorPath,
            label: 'redact-denylist',
          });
          if ((stat.mode & 0o777) !== 0o600) {
            throw new Error('redact-denylist permissions must be exactly 0600');
          }
          if (stat.size > maxBytes) {
            const error = new Error('redact-denylist exceeds AGENTBOOTUP_REDACT_DENYLIST_MAX_BYTES');
            error.code = 'redaction_denylist_file_too_large';
            throw error;
          }
          const text = decodeUtf8Strict(await handle.readFile(), 'redact-denylist');
          return parseExplicitDenylistText(text);
        } finally {
          await handle.close();
        }
      },
      REDACT_DENYLIST_LOCK_OPTIONS,
    );
  } catch (error) {
    if (error?.code === 'ENOENT') return attachExplicitSourceRecords(new Set(), new Set());
    throw error;
  }
}

export function encodeExplicitDenylistValue(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('explicit denylist value must be a non-empty string');
  }
  return `${EXPLICIT_BASE64_PREFIX}${Buffer.from(value, 'utf8').toString('base64')}`;
}

export function encodeExplicitDenylistRecord(value) {
  const taggedValue = encodeExplicitDenylistValue(value);
  const hash = createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
  return `${EXPLICIT_RECORD_MARKER_PREFIX}${hash}\n${taggedValue}`;
}

function encodedVariants(value) {
  return [Buffer.from(value, 'utf8').toString('base64'), encodeURIComponent(value)];
}

function buildDenylistFromValues(envInput, explicitInput, options = {}) {
  const environment = options.environment ?? process.env;
  const maxSourceValues = positiveInteger(
    options.maxSourceValues ?? environment.AGENTBOOTUP_REDACT_MAX_VALUES,
    DEFAULT_MAX_SOURCE_VALUES,
    'AGENTBOOTUP_REDACT_MAX_VALUES',
  );
  const envValues = new Set(envInput);
  const explicitValues = attachExplicitSourceRecords(
    new Set(explicitInput),
    explicitInput.sourceRecords ?? explicitInput,
  );
  const values = new Set(envValues);
  for (const value of explicitValues) values.add(value);
  const cappedSourceValues = new Set(envValues);
  for (const value of explicitValues.sourceRecords ?? explicitValues) cappedSourceValues.add(value);
  if (cappedSourceValues.size > maxSourceValues) {
    // explicitValues and its sourceRecords are private clones created above;
    // never clear the caller-owned options.explicitValues/history collection.
    envValues.clear();
    explicitValues.clear();
    values.clear();
    cappedSourceValues.clear();
    const error = new Error('redaction denylist source-value cap exceeded');
    error.code = 'redaction_denylist_overflow';
    throw error;
  }

  const sourceMap = new Map();
  for (const value of envValues) sourceMap.set(value, 'env');
  for (const value of explicitValues) sourceMap.set(value, 'denylist');
  const sourceValueCount = cappedSourceValues.size;
  const derivedValues = new Set();
  const derivedSourceMap = new Map();
  for (const value of values) {
    for (const variant of encodedVariants(value)) {
      if (!variant || values.has(variant)) continue;
      derivedValues.add(variant);
      derivedSourceMap.set(variant, sourceMap.get(value));
    }
  }
  envValues.clear();
  explicitValues.clear();
  cappedSourceValues.clear();
  return {
    state: values.size > 0 ? 'loaded' : 'empty-by-config',
    sourceValueCount,
    values,
    sourceMap,
    derivedValues,
    derivedSourceMap,
    health: {
      redaction_denylist_stale: false,
      redaction_denylist_overflow: false,
      redaction_denylist_file_too_large: false,
    },
  };
}

export function buildDenylist(projectRoots, options = {}) {
  const envValues = loadEnvDenylist(projectRoots, options);
  const explicitValues = options.explicitValues ?? loadExplicitDenylist(options);
  try {
    return buildDenylistFromValues(envValues, explicitValues, options);
  } finally {
    envValues.clear();
    if (options.explicitValues == null) {
      explicitValues.clear();
      explicitValues.sourceRecords?.clear();
    }
  }
}

function cloneResult(result) {
  return Object.freeze({
    ...result,
    values: readonlyCollection(new Set(result.values), new Set(['add', 'delete', 'clear'])),
    sourceMap: readonlyCollection(new Map(result.sourceMap), new Set(['set', 'delete', 'clear'])),
    derivedValues: readonlyCollection(new Set(result.derivedValues), new Set(['add', 'delete', 'clear'])),
    derivedSourceMap: readonlyCollection(new Map(result.derivedSourceMap), new Set(['set', 'delete', 'clear'])),
    health: Object.freeze({ ...result.health }),
  });
}

function readonlyCollection(collection, mutators) {
  let proxy;
  proxy = new Proxy(collection, {
    get(target, property) {
      if (mutators.has(property)) {
        return () => { throw new TypeError('denylist snapshots are read-only'); };
      }
      if (property === 'forEach') {
        return (callback, thisArg) => target.forEach((value, key) => callback.call(thisArg, value, key, proxy));
      }
      if (property === 'valueOf') return () => proxy;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return proxy;
}

function clearResult(result) {
  result?.values?.clear();
  result?.sourceMap?.clear();
  result?.derivedValues?.clear();
  result?.derivedSourceMap?.clear();
}

export function createDenylistManager(options = {}) {
  const agentbootupRoot = options.agentbootupRoot === undefined ? DEFAULT_AGENTBOOTUP_ROOT : options.agentbootupRoot;
  const projectRoots = [...new Set([
    ...(options.projectRoots ?? []),
    ...(agentbootupRoot ? [agentbootupRoot] : []),
  ].map((entry) => path.resolve(entry)))];
  const fsImpl = options.fsImpl ?? fs;
  const processImpl = options.processImpl ?? process;
  const logger = options.logger ?? (() => {});
  const pollMs = positiveInteger(options.pollMs, DEFAULT_POLL_MS, 'pollMs');
  const debounceMs = positiveInteger(options.debounceMs, DEFAULT_DEBOUNCE_MS, 'debounceMs');
  const explicitPath = options.filePath ?? path.join(os.homedir(), '.agentbootup', 'redact-denylist');
  let current = null;
  let timer = null;
  let interval = null;
  const watchers = [];
  const watcherKeys = new Set();
  let stopped = false;
  let generation = 0;
  let contentRevision = 0;
  const managerGeneration = options.managerGeneration ?? randomUUID();
  let additionRevision = 0;
  let lastLoadedValues = null;
  let lastLoadedDerivedValues = null;
  let reloadPromise = null;
  let startPromise = null;
  let startPromiseGeneration = -1;
  let hasLastKnownGood = false;
  // Monotonic for this daemon lifetime. The file remains an operator-managed
  // persistence boundary across restarts, which the runbook calls out.
  let explicitHistory = attachExplicitSourceRecords(new Set(), new Set());

  function retireResult(result) {
    clearResult(result);
    options.onCollectionsRetired?.({
      allCleared: !result || (
        result.values.size === 0 && result.sourceMap.size === 0 &&
        result.derivedValues.size === 0 && result.derivedSourceMap.size === 0
      ),
    });
  }

  function health() {
    return {
      denylist_size: current?.sourceValueCount ?? 0,
      redaction_denylist_stale: current?.health?.redaction_denylist_stale ?? true,
      redaction_denylist_overflow: current?.health?.redaction_denylist_overflow ?? false,
      redaction_denylist_file_too_large: current?.health?.redaction_denylist_file_too_large ?? false,
    };
  }

  function failedResult(errorCode, { sourceOverflow = false, fileTooLarge = false } = {}) {
    return {
      state: 'failed', values: new Set(), sourceMap: new Map(), derivedValues: new Set(),
      derivedSourceMap: new Map(), sourceValueCount: 0, errorCode, revision: contentRevision,
      managerGeneration, additionRevision,
      health: {
        redaction_denylist_stale: true,
        redaction_denylist_overflow: sourceOverflow,
        redaction_denylist_file_too_large: fileTooLarge,
      },
    };
  }

  async function performReload(runGeneration) {
    try {
      const envValues = await loadEnvDenylistAsync(projectRoots, { ...options, agentbootupRoot: null });
      let diskExplicit;
      try {
        diskExplicit = await loadExplicitDenylistAsync({ ...options, filePath: explicitPath });
      } catch (error) {
        envValues.clear();
        throw error;
      }
      if (runGeneration !== generation) {
        diskExplicit.clear();
        diskExplicit.sourceRecords?.clear();
        envValues.clear();
        return snapshot();
      }
      const candidateHistory = attachExplicitSourceRecords(
        new Set([...explicitHistory, ...diskExplicit]),
        new Set([
          ...(explicitHistory.sourceRecords ?? explicitHistory),
          ...(diskExplicit.sourceRecords ?? diskExplicit),
        ]),
      );
      diskExplicit.clear();
      diskExplicit.sourceRecords?.clear();
      // Retain newly observed history even if it causes an overflow. Recovery
      // then requires raising the cap rather than silently forgetting a value.
      const previousHistory = explicitHistory;
      explicitHistory = candidateHistory;
      previousHistory.clear();
      previousHistory.sourceRecords?.clear();
      let next;
      try {
        next = buildDenylistFromValues(envValues, explicitHistory, options);
      } finally {
        envValues.clear();
      }
      if (runGeneration !== generation || stopped) {
        clearResult(next);
        return snapshot();
      }
      const previous = current;
      if (lastLoadedValues && (
        [...next.values].some((value) => !lastLoadedValues.has(value))
        || [...next.derivedValues].some((value) => !lastLoadedDerivedValues.has(value))
      )) {
        additionRevision += 1;
      }
      next.revision = ++contentRevision;
      next.managerGeneration = managerGeneration;
      next.additionRevision = additionRevision;
      current = next;
      lastLoadedValues?.clear();
      lastLoadedDerivedValues?.clear();
      lastLoadedValues = new Set(next.values);
      lastLoadedDerivedValues = new Set(next.derivedValues);
      hasLastKnownGood = true;
      retireResult(previous);
      logger({ event: 'redaction_denylist_loaded', count: next.values.size, derivedCount: next.derivedValues.size });
    } catch (error) {
      if (runGeneration !== generation) return snapshot();
      const sourceOverflow = error?.code === 'redaction_denylist_overflow';
      const fileTooLarge = error?.code === 'redaction_denylist_file_too_large';
      const resourceLimit = sourceOverflow || fileTooLarge;
      const blockingFailure = resourceLimit || error?.code === 'redaction_denylist_record_invalid';
      if (blockingFailure && current && hasLastKnownGood) {
        retireResult(current);
        contentRevision += 1;
        current = failedResult(error.code, { sourceOverflow, fileTooLarge });
      } else if (current && hasLastKnownGood) {
        current.health.redaction_denylist_stale = true;
        // A non-overflow failure cannot prove that a prior overflow recovered.
        // Preserve the global block until a complete successful reload.
        if (current.state !== 'failed') {
          current.health.redaction_denylist_overflow = false;
          current.health.redaction_denylist_file_too_large = false;
        }
      } else {
        retireResult(current);
        contentRevision += 1;
        current = failedResult(
          blockingFailure ? error.code : 'redaction_denylist_load_failed',
          { sourceOverflow, fileTooLarge },
        );
      }
      logger({ event: 'redaction_denylist_load_failed', code: current.errorCode ?? (blockingFailure ? error.code : 'reload_failed') });
    }
    return snapshot();
  }

  function reload() {
    if (reloadPromise) return reloadPromise;
    const runGeneration = generation;
    reloadPromise = performReload(runGeneration).finally(() => { reloadPromise = null; });
    return reloadPromise;
  }

  function watchTarget(target, expectedFilename) {
    const key = `${target}\u0000${expectedFilename}`;
    if (watcherKeys.has(key)) return;
    try {
      const watcher = fsImpl.watch(target, (_event, filename) => {
        if (filename && filename !== expectedFilename) return;
        scheduleReload();
      });
      watcherKeys.add(key);
      watchers.push({ key, watcher });
    } catch (error) {
      if (error?.code !== 'ENOENT') logger({ event: 'redaction_denylist_watch_failed', code: error?.code ?? 'watch_failed' });
    }
  }

  function installWatchers() {
    for (const target of projectRoots) watchTarget(target, '.env');
    watchTarget(path.dirname(explicitPath), path.basename(explicitPath));
  }

  async function reloadAndRefreshWatchers() {
    const result = await reload();
    if (!stopped && interval) installWatchers();
    return result;
  }

  function snapshot() {
    return cloneResult(current ?? {
      state: 'failed', values: new Set(), sourceMap: new Map(), derivedValues: new Set(), derivedSourceMap: new Map(),
      sourceValueCount: 0, errorCode: 'redaction_denylist_not_loaded', revision: contentRevision,
      managerGeneration, additionRevision,
      health: {
        redaction_denylist_stale: true,
        redaction_denylist_overflow: false,
        redaction_denylist_file_too_large: false,
      },
    });
  }

  function scheduleReload() {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void reloadAndRefreshWatchers(); }, debounceMs);
    timer.unref?.();
  }

  function onSighup() {
    void reloadAndRefreshWatchers();
  }
  function onShutdown() { stop(); }

  function start() {
    if (interval) return Promise.resolve(snapshot());
    if (startPromise) {
      if (!stopped && startPromiseGeneration === generation) return startPromise;
      return startPromise.then(() => start());
    }
    stopped = false;
    generation += 1;
    const startGeneration = generation;
    startPromiseGeneration = startGeneration;
    const runStart = async () => {
      if (reloadPromise) await reloadPromise;
      if (stopped || generation !== startGeneration) return snapshot();
      await reload();
      if (stopped || generation !== startGeneration) return snapshot();
      interval = setInterval(() => { void reloadAndRefreshWatchers(); }, pollMs);
      interval.unref?.();
      installWatchers();
      if (options.manageProcessSignals !== false) {
        processImpl.on?.('SIGHUP', onSighup);
        processImpl.on?.('SIGINT', onShutdown);
        processImpl.on?.('SIGTERM', onShutdown);
      }
      return snapshot();
    };
    startPromise = runStart().finally(() => {
      if (startPromiseGeneration === startGeneration) {
        startPromise = null;
        startPromiseGeneration = -1;
      }
    });
    return startPromise;
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    generation += 1;
    if (timer) clearTimeout(timer);
    if (interval) clearInterval(interval);
    timer = null;
    interval = null;
    for (const { key, watcher } of watchers.splice(0)) {
      watcher.close?.();
      watcherKeys.delete(key);
    }
    if (options.manageProcessSignals !== false) {
      processImpl.off?.('SIGHUP', onSighup);
      processImpl.off?.('SIGINT', onShutdown);
      processImpl.off?.('SIGTERM', onShutdown);
    }
    retireResult(current);
    current = null;
    contentRevision += 1;
    hasLastKnownGood = false;
    explicitHistory.clear();
    explicitHistory.sourceRecords?.clear();
    lastLoadedValues?.clear();
    lastLoadedDerivedValues?.clear();
    lastLoadedValues = null;
    lastLoadedDerivedValues = null;
  }

  function isUsable() {
    return !stopped && Boolean(current) &&
      ['loaded', 'empty-by-config'].includes(current.state) &&
      current.health?.redaction_denylist_stale === false;
  }

  function isSnapshotCurrent(candidate) {
    return isUsable() && Number.isSafeInteger(candidate?.revision) && candidate.revision === current.revision;
  }

  return {
    start,
    stop,
    reload,
    reloadAndRefreshWatchers,
    snapshot,
    health,
    isUsable,
    isSnapshotCurrent,
    scheduleReload,
  };
}
