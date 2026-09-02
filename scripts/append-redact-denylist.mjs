#!/usr/bin/env node

import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertOwnerOnlyPath,
  encodeExplicitDenylistRecord,
  explicitDenylistMaxBytes,
  loadExplicitDenylist,
  REDACT_DENYLIST_LOCK_OPTIONS,
} from '../lib/daemon/redaction-denylist.js';
import { withFileLock } from '../lib/util/file-lock.js';

const target = process.env.AGENTBOOTUP_REDACT_DENYLIST_FILE
  ?? path.join(os.homedir(), '.agentbootup', 'redact-denylist');
if (!path.isAbsolute(target)) throw new Error('redact-denylist target must be an absolute path');
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--allow-trailing-newline') || args.length > 1) {
  throw new Error('usage: agentbootup-append-redact-denylist [--allow-trailing-newline]');
}
const allowTrailingNewline = args[0] === '--allow-trailing-newline';
if (process.platform === 'win32') {
  throw new Error('protected denylist append is unsupported on Windows until ACL validation is available');
}
const maxBytes = explicitDenylistMaxBytes();
const chunks = [];
let inputBytes = 0;
for await (const chunk of process.stdin) {
  const buffered = Buffer.from(chunk);
  inputBytes += buffered.length;
  if (inputBytes > maxBytes) {
    throw new Error('stdin exceeds AGENTBOOTUP_REDACT_DENYLIST_MAX_BYTES');
  }
  chunks.push(buffered);
}
const input = Buffer.concat(chunks);
if (input.length === 0) throw new Error('refusing to append an empty denylist value');
if (!allowTrailingNewline && (input.at(-1) === 0x0a || input.at(-1) === 0x0d)) {
  throw new Error('refusing a trailing line delimiter; emit the exact secret without a transport newline');
}
let value;
try {
  value = new TextDecoder('utf-8', { fatal: true }).decode(input);
} catch {
  throw new Error('redact-denylist values must be valid UTF-8 text');
}
if (!Buffer.from(value, 'utf8').equals(input)) {
  throw new Error('redact-denylist value did not round-trip as exact UTF-8 text');
}
const encodedRecord = `${encodeExplicitDenylistRecord(value)}\n`;
if (Buffer.byteLength(encodedRecord) > maxBytes) {
  throw new Error('append would exceed AGENTBOOTUP_REDACT_DENYLIST_MAX_BYTES');
}

const directory = path.dirname(target);
async function validateDirectoryChain(directoryPath, { allowMissing = false } = {}) {
  const expectedUid = process.getuid?.();
  const resolved = path.resolve(directoryPath);
  const parsed = path.parse(resolved);
  let cursor = parsed.root;
  for (const component of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    let stat;
    try {
      stat = await fsp.lstat(cursor);
    } catch (error) {
      if (allowMissing && error?.code === 'ENOENT') return false;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('redact-denylist parent must contain only regular non-symlink directories');
    }
    const mode = stat.mode & 0o7777;
    if (Number.isSafeInteger(expectedUid) && stat.uid !== expectedUid && stat.uid !== 0) {
      throw new Error('redact-denylist parent ancestor must be owned by the operating account or root');
    }
    if ((mode & 0o022) !== 0 && (mode & 0o1000) === 0) {
      throw new Error('redact-denylist parent ancestor must not be writable by group or other');
    }
  }
  return true;
}

let directoryStat;
if (!await validateDirectoryChain(directory, { allowMissing: true })) {
  const containingDirectory = path.dirname(directory);
  await validateDirectoryChain(containingDirectory);
  try {
    await fsp.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
}
await validateDirectoryChain(directory);
directoryStat = await fsp.lstat(directory);
assertOwnerOnlyPath(directory, directoryStat, { label: 'redact-denylist parent' });
if ((directoryStat.mode & 0o777) !== 0o700) {
  throw new Error('redact-denylist parent permissions must be exactly 0700');
}
await withFileLock(target, async () => {
  let existing;
  try {
    existing = await fsp.lstat(target);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error('redact-denylist must be a regular non-symlink file');
  }
  if (existing && existing.nlink !== 1) {
    throw new Error('redact-denylist must not be hard linked');
  }
  if (existing) assertOwnerOnlyPath(target, existing, { label: 'redact-denylist' });
  if (existing && (existing.mode & 0o777) !== 0o600) {
    throw new Error('redact-denylist permissions must be exactly 0600');
  }
  if (existing) {
    loadExplicitDenylist({
      filePath: target,
      lockAlreadyHeld: true,
      maxExplicitBytes: maxBytes,
    });
  }

  const handle = await fsp.open(
    target,
    fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('redact-denylist must be a regular file');
    if (stat.nlink !== 1) throw new Error('redact-denylist must not be hard linked');
    assertOwnerOnlyPath(target, stat, { label: 'redact-denylist' });
    if ((stat.mode & 0o777) !== 0o600) {
      throw new Error('redact-denylist permissions must be exactly 0600');
    }
    let separator = '';
    if (stat.size > 0) {
      const lastByte = Buffer.allocUnsafe(1);
      const { bytesRead } = await handle.read(lastByte, 0, 1, stat.size - 1);
      if (bytesRead !== 1) throw new Error('could not inspect the existing denylist delimiter');
      if (lastByte[0] !== 0x0a && lastByte[0] !== 0x0d) separator = '\n';
    }
    if (stat.size + Buffer.byteLength(separator) + Buffer.byteLength(encodedRecord) > maxBytes) {
      throw new Error('append would exceed AGENTBOOTUP_REDACT_DENYLIST_MAX_BYTES');
    }
    await handle.writeFile(`${separator}${encodedRecord}`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (process.platform !== 'win32') {
    const directoryHandle = await fsp.open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    try { await directoryHandle.sync(); }
    finally { await directoryHandle.close(); }
  }
}, REDACT_DENYLIST_LOCK_OPTIONS);
process.stderr.write('Appended one protected denylist history record.\n');
