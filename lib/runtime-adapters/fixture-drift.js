import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { STATE_CLASSES } from './types.js';
import { findRawSecretViolations } from './security.js';

const require = createRequire(import.meta.url);
const matrix = require('../../config/runtime-adapter-support-matrix-v1.json');

const FIXTURES = Object.freeze([
  'circle-agent/0.1.0-linux-amd64-sanitized',
  'hermes/0.18.2-darwin-arm64-real',
  'openclaw/2026.6.6-darwin-arm64-real',
]);
const CLASS_SET = new Set(STATE_CLASSES);
const FIXTURE_FIELDS = Object.freeze({
  circle_agent: ['fixture_version', 'runtime_family', 'runtime_version', 'source_commit', 'agent_host', 'platform', 'missing_exact_pins', 'generated', 'sanitized', 'm0_qualifying', 'database', 'expected_classes', 'tree_integrity'],
  hermes: ['fixture_version', 'runtime_family', 'runtime_version', 'runtime_commit', 'qualification_scope', 'platform', 'generated', 'sanitized', 'credential_policy', 'artifacts', 'semantic_canaries', 'expected_classes', 'native_archive_observations', 'native_archive_integrity', 'tree_integrity'],
  openclaw: ['fixture_version', 'runtime_family', 'runtime_version', 'runtime_commit', 'package_integrity', 'platform', 'generated', 'sanitized', 'credential_policy', 'artifacts', 'expected_classes', 'native_archive_observations', 'native_archive_integrity', 'tree_integrity'],
});
const MACHINE_PATH_RE = /(?:\/Users\/[A-Za-z0-9._-]+(?:\/|$)|\/home\/[A-Za-z0-9._-]+(?:\/|$)|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+(?:\\|$)|(?:^|[\s"'=:])\\\\[A-Za-z0-9._-]+\\[A-Za-z0-9._$-]+)/im;
const OPENCLAW_DISPOSABLE_ROOT = '/private/tmp/agentbootup-openclaw-home';
const OPENCLAW_SENTINEL = 'fixture-only-not-a-secret';
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_MEMBERS = 4096;
const MAX_MEMBER_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_OUTPUT = 64 * 1024 * 1024;
const LEGACY_HERMES_FIXTURE = Object.freeze({
  runtime_version: '0.18.2',
  runtime_commit: '46e87b14fd6c943ef0d6671fb0d74c5dde5d4c6b',
  platform: Object.freeze({
    os: 'darwin', os_version: '14', architecture: 'arm64', python: '3.11.15',
  }),
});
const WINDOWS_ZIP_ATTRIBUTES = Object.freeze({
  READONLY: 0x00000001,
  HIDDEN: 0x00000002,
  SYSTEM: 0x00000004,
  VOLUME_LABEL: 0x00000008,
  DIRECTORY: 0x00000010,
  ARCHIVE: 0x00000020,
  DEVICE: 0x00000040,
  NORMAL: 0x00000080,
  TEMPORARY: 0x00000100,
  SPARSE_FILE: 0x00000200,
  REPARSE_POINT: 0x00000400,
  COMPRESSED: 0x00000800,
  OFFLINE: 0x00001000,
  NOT_CONTENT_INDEXED: 0x00002000,
  ENCRYPTED: 0x00004000,
  INTEGRITY_STREAM: 0x00008000,
  NO_SCRUB_DATA: 0x00020000,
  PINNED: 0x00080000,
  UNPINNED: 0x00100000,
  RECALL_ON_DATA_ACCESS: 0x00400000,
});
const WINDOWS_ZIP_ALLOWED_ATTRIBUTES = [
  'READONLY', 'HIDDEN', 'SYSTEM', 'DIRECTORY', 'ARCHIVE', 'NORMAL',
  'TEMPORARY', 'SPARSE_FILE', 'COMPRESSED', 'OFFLINE',
  'NOT_CONTENT_INDEXED', 'ENCRYPTED', 'INTEGRITY_STREAM', 'NO_SCRUB_DATA',
  'PINNED', 'UNPINNED', 'RECALL_ON_DATA_ACCESS',
].reduce((mask, name) => mask | WINDOWS_ZIP_ATTRIBUTES[name], 0) >>> 0;
// Intentionally excluded Microsoft values remain unknown and fail closed:
// 0x00010000 VIRTUAL is reserved for system use; 0x00040000 is ambiguous
// between internal-only EA and RECALL_ON_OPEN placeholder semantics.

function isRecord(value) { return value != null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function text(value) { return typeof value === 'string' && value.trim().length > 0; }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function lexical(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort(lexical).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function ownFields(value, allowed, label, errors) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key)).sort(lexical);
  if (unexpected.length) errors.push(`${label}: unsupported metadata fields: ${unexpected.join(', ')}`);
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
  if (missing.length) errors.push(`${label}: missing metadata fields: ${missing.join(', ')}`);
}
function jsonClone(value) { return JSON.parse(JSON.stringify(value)); }
function safeRelativeLocator(value) {
  if (!text(value) || /[\0-\x1f\x7f\\]/.test(value) || value.startsWith('/') || value.startsWith('//') || /^[A-Za-z]:/.test(value)) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== '.' && !normalized.startsWith('../') && !value.split('/').includes('..') && !value.split('/').includes('');
}
function validateLocator(value, label, errors) {
  if (!safeRelativeLocator(value)) { errors.push(`${label}: locator must be a normalized contained relative path`); return false; }
  return true;
}
async function safeRegularFile(rootReal, absolute, label, errors) {
  let stat;
  try { stat = await fs.lstat(absolute); } catch { errors.push(`${label}: file is missing`); return false; }
  if (!stat.isFile() || stat.isSymbolicLink()) { errors.push(`${label}: must be a regular non-symlink file`); return false; }
  let real;
  try { real = await fs.realpath(absolute); } catch { errors.push(`${label}: realpath cannot be resolved`); return false; }
  if (real !== rootReal && !real.startsWith(`${rootReal}${path.sep}`)) { errors.push(`${label}: realpath escapes fixture containment`); return false; }
  return true;
}

async function filesBelow(root) {
  const result = [];
  const rootReal = await fs.realpath(root);
  async function walk(directory, prefix = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => lexical(left.name, right.name));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) { result.push({ path: relative, kind: 'symlink' }); continue; }
      const real = await fs.realpath(absolute);
      if (real !== rootReal && !real.startsWith(`${rootReal}${path.sep}`)) { result.push({ path: relative, kind: 'escape' }); continue; }
      if (stat.isDirectory()) {
        const before = result.length;
        await walk(absolute, relative);
        if (result.length === before) result.push({ path: relative, kind: 'empty_directory' });
      } else if (stat.isFile()) result.push({ path: relative, kind: 'file', size_bytes: stat.size });
      else result.push({ path: relative, kind: stat.isSocket() ? 'socket' : stat.isFIFO() ? 'fifo' : stat.isCharacterDevice() ? 'character_device' : stat.isBlockDevice() ? 'block_device' : 'special' });
    }
  }
  await walk(root);
  return result;
}

async function calculateTree(root, files) {
  const entries = [];
  for (const relative of files) {
    const bytes = await fs.readFile(path.join(root, relative));
    entries.push({ path: relative, size_bytes: bytes.length, sha256: sha256(bytes) });
  }
  return { files: entries, digest: sha256(entries.map((entry) => `${entry.path}\0${entry.size_bytes}\0${entry.sha256}\n`).join('')) };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
function validateMemberName(name, namespace, directory) {
  if (!name || /[\0-\x1f\x7f]/.test(name) || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.includes('\\')) throw new Error(`unsafe archive member ${JSON.stringify(name)}`);
  const canonicalName = name.endsWith('/') ? name.slice(0, -1) : name;
  if (!canonicalName || canonicalName.endsWith('/') || canonicalName.includes('//')) throw new Error(`unsafe archive member ${JSON.stringify(name)} contains an empty segment`);
  const segments = canonicalName.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) throw new Error(`unsafe archive member ${JSON.stringify(name)}`);
  if (segments.some((segment) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment.replace(/[ .]+$/, '')) || segment.includes(':') || /[ .]$/.test(segment))) throw new Error(`Windows-unsafe archive member ${JSON.stringify(name)}`);
  const collisionKey = canonicalName.normalize('NFC').toLowerCase();
  const existing = namespace.get(collisionKey);
  if (existing?.explicit) throw new Error(`archive member path collision ${JSON.stringify(name)}`);
  for (let index = 1; index < segments.length; index += 1) {
    const ancestor = segments.slice(0, index).join('/').normalize('NFC').toLowerCase();
    const ancestorEntry = namespace.get(ancestor);
    if (ancestorEntry && !ancestorEntry.directory) throw new Error(`archive member namespace conflict ${JSON.stringify(name)}: ancestor ${JSON.stringify(segments.slice(0, index).join('/'))} is not a directory`);
    if (!ancestorEntry) namespace.set(ancestor, { directory: true, explicit: false });
  }
  if (existing && !directory) throw new Error(`archive member namespace conflict ${JSON.stringify(name)}: a non-directory cannot replace an implicit directory with descendants`);
  namespace.set(collisionKey, { directory, explicit: true });
}
function zipMemberType(name, host, externalAttributes) {
  const UNIX_HOSTS = new Set([3, 19]);
  // PKWARE APPNOTE 4.4.2 assigns 0 to DOS/FAT, 10 to Windows NTFS, and 14
  // to VFAT. Host 0 uses APPNOTE 4.4.15's DOS low-byte encoding. Windows
  // hosts use Microsoft's documented FILE_ATTRIBUTE_* word; the explicit
  // allowlist excludes reparse points and reserved/ambiguous metadata.
  const WINDOWS_HOSTS = new Map([[10, 'NTFS'], [14, 'VFAT']]);
  if (UNIX_HOSTS.has(host)) {
    const mode = externalAttributes >>> 16;
    const type = mode & 0xf000;
    if (type === 0) return name.endsWith('/') ? 'directory' : 'regular';
    if (type === 0x8000) return 'regular';
    if (type === 0x4000) return 'directory';
    const labels = new Map([
      [0xc000, 'socket'], [0xa000, 'symlink'], [0x6000, 'block device'],
      [0x2000, 'character device'], [0x1000, 'FIFO'],
    ]);
    throw new Error(`unsupported UNIX ZIP member type ${labels.get(type) || `0x${type.toString(16)}`} for ${name}`);
  }
  if (host === 0) {
    const attributes = externalAttributes & 0xff;
    if (externalAttributes >>> 8) throw new Error(`unsupported DOS ZIP member attributes 0x${externalAttributes.toString(16)} for ${name}`);
    if (attributes & 0xc8) throw new Error(`unsupported DOS ZIP member attributes 0x${attributes.toString(16)} for ${name}`);
    if (attributes === 0) return name.endsWith('/') ? 'directory' : 'regular';
    return attributes & 0x10 ? 'directory' : 'regular';
  }
  if (WINDOWS_HOSTS.has(host)) {
    const label = WINDOWS_HOSTS.get(host);
    if (externalAttributes & WINDOWS_ZIP_ATTRIBUTES.VOLUME_LABEL) throw new Error(`unsupported ${label} ZIP volume-label attribute for ${name}`);
    if (externalAttributes & WINDOWS_ZIP_ATTRIBUTES.DEVICE) throw new Error(`unsupported ${label} ZIP device attribute for ${name}`);
    if (externalAttributes & WINDOWS_ZIP_ATTRIBUTES.REPARSE_POINT) throw new Error(`unsupported ${label} ZIP reparse-point attribute for ${name}`);
    const unknown = (externalAttributes & (~WINDOWS_ZIP_ALLOWED_ATTRIBUTES >>> 0)) >>> 0;
    if (unknown) throw new Error(`unsupported ${label} ZIP member attributes 0x${externalAttributes.toString(16)} for ${name}`);
    if ((externalAttributes & WINDOWS_ZIP_ATTRIBUTES.NORMAL) && externalAttributes !== WINDOWS_ZIP_ATTRIBUTES.NORMAL) throw new Error(`ambiguous ${label} ZIP normal attribute combination for ${name}`);
    if ((externalAttributes & (WINDOWS_ZIP_ATTRIBUTES.PINNED | WINDOWS_ZIP_ATTRIBUTES.UNPINNED)) === (WINDOWS_ZIP_ATTRIBUTES.PINNED | WINDOWS_ZIP_ATTRIBUTES.UNPINNED)) throw new Error(`ambiguous ${label} ZIP pinned/unpinned attributes for ${name}`);
    if (externalAttributes === 0) return name.endsWith('/') ? 'directory' : 'regular';
    return externalAttributes & WINDOWS_ZIP_ATTRIBUTES.DIRECTORY ? 'directory' : 'regular';
  }
  if (externalAttributes !== 0) throw new Error(`unsupported ZIP creator host ${host} with declared external attributes for ${name}`);
  return name.endsWith('/') ? 'directory' : 'regular';
}
function zipMembers(bytes) {
  const searchStart = Math.max(0, bytes.length - 65557);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= searchStart; offset -= 1) if (bytes.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  if (eocd < 0 || eocd + 22 > bytes.length) throw new Error('ZIP EOCD is missing');
  const commentLength = bytes.readUInt16LE(eocd + 20);
  if (eocd + 22 + commentLength !== bytes.length) throw new Error('ZIP EOCD bounds are invalid');
  const disk = bytes.readUInt16LE(eocd + 4); const centralDisk = bytes.readUInt16LE(eocd + 6);
  const entries = bytes.readUInt16LE(eocd + 10); const diskEntries = bytes.readUInt16LE(eocd + 8);
  const centralSize = bytes.readUInt32LE(eocd + 12); const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (disk || centralDisk || entries !== diskEntries || entries === 0 || entries > MAX_ARCHIVE_MEMBERS || centralOffset + centralSize !== eocd) throw new Error('ZIP central directory bounds/count are invalid');
  const members = []; const namespace = new Map(); let total = 0; let offset = centralOffset;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > eocd || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP central directory entry is invalid');
    const host = bytes[offset + 5];
    const flags = bytes.readUInt16LE(offset + 8);
    const compression = bytes.readUInt16LE(offset + 10);
    const expectedCrc = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    if (flags & 1) throw new Error('encrypted ZIP members are unsupported');
    if (flags & 0x0008) throw new Error('ZIP data descriptors are unsupported');
    if (flags & ~0x0800) throw new Error(`unsupported ZIP general-purpose flags 0x${flags.toString(16)}`);
    if (![0, 8].includes(compression)) throw new Error(`unsupported ZIP compression method ${compression}`);
    if (uncompressedSize > MAX_MEMBER_BYTES) throw new Error('ZIP member exceeds the fixture limit');
    if (compressedSize > 0 && uncompressedSize / compressedSize > 1000) throw new Error('ZIP member compression ratio exceeds limit');
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const externalAttributes = bytes.readUInt32LE(offset + 38);
    const localOffset = bytes.readUInt32LE(offset + 42);
    if (offset + 46 + nameLength + extraLength + commentLength > eocd) throw new Error('ZIP central directory entry bounds are invalid');
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const memberType = zipMemberType(name, host, externalAttributes);
    const directory = memberType === 'directory';
    const directoryMarker = name.endsWith('/');
    if (directory !== directoryMarker) throw new Error(`ZIP member ${name} declared ${memberType} type conflicts with its terminal slash`);
    validateMemberName(name, namespace, directory);
    let content = Buffer.alloc(0);
    if (localOffset + 30 > centralOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`ZIP member ${name} local header is invalid`);
    const localFlags = bytes.readUInt16LE(localOffset + 6); const localCompression = bytes.readUInt16LE(localOffset + 8);
    if (localFlags !== flags || localCompression !== compression) throw new Error(`ZIP member ${name} local-central mismatch`);
    if (bytes.readUInt32LE(localOffset + 14) !== expectedCrc || bytes.readUInt32LE(localOffset + 18) !== compressedSize || bytes.readUInt32LE(localOffset + 22) !== uncompressedSize) throw new Error(`ZIP member ${name} local-central size/CRC mismatch`);
    {
      const localNameLength = bytes.readUInt16LE(localOffset + 26);
      const localExtraLength = bytes.readUInt16LE(localOffset + 28);
      if (localOffset + 30 + localNameLength + localExtraLength > centralOffset) throw new Error(`ZIP member ${name} local header bounds are invalid`);
      const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8');
      if (localName !== name) throw new Error(`ZIP member ${name} local-central name mismatch`);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      if (start + compressedSize > centralOffset) throw new Error(`ZIP member ${name} content bounds are invalid`);
      const compressed = bytes.subarray(start, start + compressedSize);
      if (compression === 0) content = Buffer.from(compressed);
      else content = inflateRawSync(compressed, { maxOutputLength: Math.min(MAX_MEMBER_BYTES, uncompressedSize + 1) });
      if (content.length !== uncompressedSize) throw new Error(`ZIP member ${name} size mismatch`);
      if (crc32(content) !== expectedCrc) throw new Error(`ZIP member ${name} CRC32 mismatch`);
    }
    if (directory && content.length !== 0) throw new Error(`ZIP directory member ${name} must not contain payload bytes`);
    total += content.length; if (total > MAX_ARCHIVE_OUTPUT) throw new Error('ZIP cumulative output exceeds limit');
    members.push({ name, content });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== eocd) throw new Error('ZIP central directory size mismatch');
  return members.sort((left, right) => lexical(left.name, right.name));
}

function tarMembers(gzipBytes) {
  const bytes = gunzipSync(gzipBytes, { maxOutputLength: MAX_ARCHIVE_OUTPUT });
  const members = []; const namespace = new Map(); let total = 0; let terminated = false;
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (offset + 1024 > bytes.length || !bytes.subarray(offset, offset + 1024).every((byte) => byte === 0) || !bytes.subarray(offset).every((byte) => byte === 0)) throw new Error('TAR end-of-archive blocks/trailing bytes are invalid');
      terminated = true;
      break;
    }
    const readString = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/, '');
    const name = `${readString(345, 155) ? `${readString(345, 155)}/` : ''}${readString(0, 100)}`;
    const storedChecksum = Number.parseInt(readString(148, 8).trim().replace(/\0.*$/, '') || '0', 8);
    const checksumHeader = Buffer.from(header); checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (storedChecksum !== actualChecksum) throw new Error(`TAR member ${name} header checksum mismatch`);
    const sizeText = readString(124, 12).trim().replace(/^0+/, '') || '0';
    const size = Number.parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`TAR member ${name} has invalid size`);
    if (size > MAX_MEMBER_BYTES) throw new Error(`TAR member ${name} exceeds fixture limit`);
    const type = readString(156, 1) || '0';
    if (!['0', '\0', '5'].includes(type)) throw new Error(`unsupported TAR member type ${JSON.stringify(type)} for ${name}`);
    const directoryMarker = name.endsWith('/');
    validateMemberName(name, namespace, type === '5');
    if (directoryMarker && type !== '5') throw new Error(`TAR terminal slash is only valid for a directory marker: ${name}`);
    if (type === '5' && size !== 0) throw new Error(`TAR directory member ${name} must not contain payload bytes`);
    const end = offset + 512 + size; if (end > bytes.length) throw new Error(`TAR member ${name} exceeds archive bounds`);
    const content = ['0', '\0'].includes(type) ? Buffer.from(bytes.subarray(offset + 512, end)) : Buffer.alloc(0);
    total += content.length; if (total > MAX_ARCHIVE_OUTPUT || members.length >= MAX_ARCHIVE_MEMBERS) throw new Error('TAR cumulative/count limit exceeded');
    members.push({ name, content });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (members.length === 0 || !terminated) throw new Error('TAR archive is empty or unterminated');
  return members.sort((left, right) => lexical(left.name, right.name));
}

function scanText(label, content, errors, { allowOpenClawSentinel = false, allowDisposableRoot = false } = {}) {
  let inspected = Buffer.isBuffer(content) ? content.toString('latin1') : content;
  if (allowOpenClawSentinel) {
    try {
      const parsed = JSON.parse(Buffer.isBuffer(content) ? content.toString('utf8') : content);
      if (parsed?.gateway?.auth?.token === OPENCLAW_SENTINEL) parsed.gateway.auth.token = '[redacted]';
      inspected = JSON.stringify(parsed);
    } catch { /* sentinel remains visible and fails below */ }
  }
  if (inspected.includes(OPENCLAW_SENTINEL)) errors.push(`${label}: OpenClaw sentinel is permitted only at state/openclaw.json#/gateway/auth/token`);
  if (allowDisposableRoot) inspected = inspected.replaceAll(OPENCLAW_DISPOSABLE_ROOT, '<DISPOSABLE_ROOT>');
  if (MACHINE_PATH_RE.test(inspected)) errors.push(`${label}: machine-specific home/drive/UNC path detected`);
  let parsed = null;
  try { parsed = JSON.parse(inspected); } catch {}
  const violations = parsed == null ? [] : findRawSecretViolations(parsed);
  const providerCredential = /(?:sk-(?:proj|ant)-[A-Za-z0-9_-]{20,}|(?:authorization|x-api-key|api[_-]?key|password|client[_-]?secret|access[_-]?token)\s*[:=]\s*(?:bearer\s+)?(?!\[redacted\]|<reference>)[A-Za-z0-9._~+\/-]{8,})/i.test(inspected);
  if (violations.length || providerCredential) errors.push(`${label}: raw secret-shaped content detected${violations.length ? ` at ${violations.join(', ')}` : ''}`);
}

async function validateArchive(family, fixtureDir, relative, digest, errors) {
  const absolute = path.join(fixtureDir, relative);
  let bytes;
  try { bytes = await fs.readFile(absolute); } catch { errors.push(`${family}: native archive ${relative} is missing`); return null; }
  if (bytes.length > MAX_FILE_BYTES) { errors.push(`${family}: native archive ${relative} exceeds the fixture limit`); return null; }
  if (`sha256:${sha256(bytes)}` !== digest) errors.push(`${family}: artifact integrity mismatch for ${relative}`);
  let members;
  try { members = relative.endsWith('.zip') ? zipMembers(bytes) : tarMembers(bytes); }
  catch (error) { errors.push(`${family}: native archive ${relative} cannot be inspected: ${error.message}`); return null; }
  const names = members.map((member) => member.name);
  for (const member of members) {
    if (member.content.length) scanText(`${family} archive member ${member.name}`, member.content, errors, {
      allowOpenClawSentinel: family === 'openclaw' && /\/payload\/posix\/private\/tmp\/agentbootup-openclaw-home\/\.openclaw\/openclaw\.json(?:\.bak)?$/.test(member.name),
      allowDisposableRoot: family === 'openclaw',
    });
  }
  if (family === 'hermes') {
    for (const required of ['state.db', '.env', 'auth.json', 'profiles/research/profile.yaml', 'skills/fixture-skill/SKILL.md']) if (!names.includes(required)) errors.push(`hermes: native archive missing required member ${required}`);
    for (const forbidden of ['state.db-wal', 'state.db-shm', 'gateway.pid', 'node_modules/']) if (names.some((name) => name === forbidden || name.startsWith(forbidden))) errors.push(`hermes: native archive unexpectedly contains ${forbidden}`);
  } else if (family === 'openclaw') {
    for (const suffix of ['/manifest.json', '/payload/posix/private/tmp/agentbootup-openclaw-home/.openclaw/state/openclaw.sqlite', '/workspace/.git/HEAD', '/workspace-research/.git/HEAD']) {
      if (!names.some((name) => name.endsWith(suffix))) errors.push(`openclaw: native archive missing evidence member *${suffix}`);
    }
    if (!names.some((name) => name.includes('/payload/posix/private/tmp/agentbootup-openclaw-home/'))) errors.push('openclaw: expected absolute-source-path encoding evidence is absent');
  }
  return { path: relative, sha256: digest.slice(7), members: members.length, membership_sha256: sha256(names.join('\n') + '\n') };
}

function validateExpectedClasses(metadata, treeFiles, label, errors) {
  if (!isRecord(metadata.expected_classes)) { errors.push(`${label}: expected_classes must be an object`); return 0; }
  const keys = Object.keys(metadata.expected_classes).sort(lexical);
  if (canonical(keys) !== canonical([...STATE_CLASSES].sort(lexical))) errors.push(`${label}: expected_classes must declare every state class exactly once`);
  const references = [];
  for (const [stateClass, values] of Object.entries(metadata.expected_classes)) {
    if (!CLASS_SET.has(stateClass) || !Array.isArray(values) || values.some((item) => !text(item))) errors.push(`${label}: expected_classes.${stateClass} is invalid`);
    else for (const value of values) {
      const base = value.includes('#/') ? value.slice(0, value.indexOf('#/')) : value;
      if (!validateLocator(base, `${label}.expected_classes.${stateClass}`, errors)) continue;
      scanText(`${label} expected_classes.${stateClass}`, Buffer.from(value), errors);
      references.push({ stateClass, value });
    }
  }
  for (const { stateClass, value } of references) {
    const pointerAt = value.indexOf('#/');
    const base = pointerAt < 0 ? value : value.slice(0, pointerAt);
    const matched = treeFiles.some((file) => file === base || (pointerAt < 0 && file.startsWith(`${base}/`)));
    if (!matched && !value.startsWith('fixture.json#/')) errors.push(`${label}: stale expected-class reference ${stateClass}:${value}`);
  }
  const nonPointers = references.filter(({ value }) => !value.includes('#/'));
  for (let index = 0; index < nonPointers.length; index += 1) for (let other = index + 1; other < nonPointers.length; other += 1) {
    const left = nonPointers[index]; const right = nonPointers[other];
    if (left.value === right.value || left.value.startsWith(`${right.value}/`) || right.value.startsWith(`${left.value}/`)) errors.push(`${label}: overlapping expected-class references ${left.stateClass}:${left.value} and ${right.stateClass}:${right.value}`);
  }
  let accounted = 0;
  for (const file of treeFiles) {
    let matches = references.filter(({ value }) => !value.includes('#/') && (file === value || file.startsWith(`${value}/`)));
    if (matches.length === 0) matches = references.filter(({ value }) => value.includes('#/') && file === value.slice(0, value.indexOf('#/')));
    if (matches.length === 0) errors.push(`${label}: source file is not class-accounted: ${file}`);
    else if (matches.length > 1) errors.push(`${label}: source file has ambiguous class accounting: ${file}`);
    else accounted += 1;
  }
  return accounted;
}

function validatePins(metadata, label, errors) {
  if (metadata.generated !== true || metadata.sanitized !== true) {
    errors.push(`${label}: generated and sanitized attestations must both be true`);
  }
  if (metadata.runtime_family === 'hermes' &&
      metadata.qualification_scope === 'legacy_regression_only') {
    const activeIdentity = matrix.lanes.some((item) =>
      item.runtime_family === 'hermes' &&
      item.runtime_version === metadata.runtime_version &&
      item.platform.os === metadata.platform?.os &&
      item.platform.os_version === metadata.platform?.os_version &&
      item.platform.architecture === metadata.platform?.architecture &&
      item.platform.runtime === 'python' &&
      item.platform.runtime_version === metadata.platform?.python);
    if (activeIdentity) errors.push(`${label}: legacy regression fixture must not match an active support-matrix lane`);
    if (metadata.runtime_version !== LEGACY_HERMES_FIXTURE.runtime_version ||
        metadata.runtime_commit !== LEGACY_HERMES_FIXTURE.runtime_commit ||
        canonical(metadata.platform) !== canonical(LEGACY_HERMES_FIXTURE.platform)) {
      errors.push(`${label}: legacy regression fixture identity drifted from its frozen 0.18.2 pins`);
    }
    return;
  }
  if (metadata.runtime_family === 'hermes') {
    errors.push(`${label}: historical Hermes fixture must declare qualification_scope legacy_regression_only`);
  }
  const lane = metadata.runtime_family === 'circle_agent'
    ? matrix.deferred_candidates.find((item) => item.runtime_family === metadata.runtime_family)
    : matrix.lanes.find((item) =>
      item.runtime_family === metadata.runtime_family &&
      item.runtime_version === metadata.runtime_version &&
      item.platform.os === metadata.platform?.os &&
      item.platform.os_version === metadata.platform?.os_version &&
      item.platform.architecture === metadata.platform?.architecture &&
      item.platform.runtime === (
        metadata.runtime_family === 'hermes' ? 'python' : 'node'
      ) &&
      item.platform.runtime_version === (
        metadata.runtime_family === 'hermes' ? metadata.platform?.python : metadata.platform?.node
      ));
  if (!lane) { errors.push(`${label}: runtime_family has no configured evidence lane`); return; }
  if (metadata.runtime_version !== lane.runtime_version) errors.push(`${label}: runtime_version must be exact pin ${lane.runtime_version}`);
  if (metadata.platform?.os !== lane.platform.os || metadata.platform?.architecture !== lane.platform.architecture) errors.push(`${label}: platform must match exact ${lane.platform.os}/${lane.platform.architecture} evidence lane`);
  if (metadata.runtime_family === 'hermes' && (metadata.platform?.os_version !== lane.platform.os_version || metadata.platform?.python !== lane.platform.runtime_version)) errors.push(`${label}: exact OS/Python platform pins do not match support matrix`);
  if (metadata.runtime_family === 'openclaw' && (metadata.platform?.os_version !== lane.platform.os_version || metadata.platform?.node !== lane.platform.runtime_version)) errors.push(`${label}: exact OS/Node platform pins do not match support matrix`);
  if (metadata.runtime_family === 'circle_agent') {
    if (metadata.m0_qualifying !== false) errors.push(`${label}: Circle candidate must remain explicitly non-M0`);
    const missingCirclePins = ['platform.os_version', 'platform.bun'];
    if (canonical(lane.missing_exact_pins) !== canonical(missingCirclePins) || canonical(metadata.missing_exact_pins) !== canonical(lane.missing_exact_pins)) errors.push(`${label}: Circle candidate and fixture must identically name missing exact Linux/Bun pins`);
    if (metadata.source_commit !== lane.provenance.source_commit || metadata.agent_host?.version !== lane.provenance.agent_host_version || metadata.agent_host?.source_commit !== lane.provenance.agent_host_commit || metadata.agent_host?.image !== `ghcr.io/dundas/agent-host@${lane.provenance.image_digest}`) errors.push(`${label}: candidate commits/image digest do not match support evidence`);
  }
  if (metadata.runtime_family !== 'circle_agent' && metadata.runtime_commit !== lane.provenance.source_commit) errors.push(`${label}: runtime_commit does not match support matrix`);
  if (metadata.runtime_family === 'openclaw' && metadata.package_integrity !== lane.provenance.package_integrity) errors.push(`${label}: package_integrity does not match support matrix`);
}

async function validateFixture(fixtureRoot, relative, errors) {
  const fixtureDir = path.join(fixtureRoot, relative);
  const fixtureRootReal = await fs.realpath(fixtureRoot);
  let fixtureStat; let fixtureReal;
  try { fixtureStat = await fs.lstat(fixtureDir); fixtureReal = await fs.realpath(fixtureDir); }
  catch { errors.push(`${relative}: fixture directory is missing or inaccessible`); return { runtime_family: relative, discovered_sources: 0, accounted_sources: 0, native_archive: null }; }
  if (fixtureStat.isSymbolicLink() || (fixtureReal !== fixtureRootReal && !fixtureReal.startsWith(`${fixtureRootReal}${path.sep}`))) {
    errors.push(`${relative}: fixture directory is symlinked or escapes fixture_root`);
    return { runtime_family: relative, discovered_sources: 0, accounted_sources: 0, native_archive: null };
  }
  let metadata;
  const metadataPath = path.join(fixtureDir, 'fixture.json');
  if (!(await safeRegularFile(fixtureReal, metadataPath, `${relative}/fixture.json`, errors))) return { runtime_family: relative, discovered_sources: 0, accounted_sources: 0, native_archive: null };
  try { metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')); }
  catch (error) { errors.push(`${relative}: fixture.json is invalid or missing: ${error.message}`); return { runtime_family: relative, discovered_sources: 0, accounted_sources: 0, native_archive: null }; }
  const label = metadata.runtime_family || relative;
  const { expected_classes: expectedClassesForSeparateValidation, ...metadataWithoutTaxonomyKeys } = metadata;
  scanText(`${label} fixture.json`, Buffer.from(JSON.stringify(metadataWithoutTaxonomyKeys)), errors, { allowOpenClawSentinel: false });
  if (!FIXTURE_FIELDS[label]) { errors.push(`${label}: unsupported fixture family`); return { runtime_family: label, discovered_sources: 0, accounted_sources: 0, native_archive: null }; }
  ownFields(metadata, FIXTURE_FIELDS[label], label, errors);
  if (metadata.fixture_version !== 1) errors.push(`${label}: fixture_version must be 1`);
  validatePins(metadata, label, errors);
  const platformFields = label === 'circle_agent' ? ['os', 'os_version', 'architecture', 'bun'] : label === 'hermes' ? ['os', 'os_version', 'architecture', 'python'] : ['os', 'os_version', 'architecture', 'node'];
  if (!isRecord(metadata.platform)) errors.push(`${label}: platform must be an object`);
  else ownFields(metadata.platform, platformFields, `${label}.platform`, errors);
  if (label === 'circle_agent') {
    if (metadata.platform?.os_version !== null || metadata.platform?.bun !== null || canonical(metadata.missing_exact_pins) !== canonical(['platform.os_version', 'platform.bun'])) errors.push('circle_agent: missing exact Linux/Bun pins must be null and explicitly named');
    if (!isRecord(metadata.agent_host)) errors.push('circle_agent: agent_host must be an object');
    else ownFields(metadata.agent_host, ['version', 'source_commit', 'image'], 'circle_agent.agent_host', errors);
    if (!isRecord(metadata.database)) errors.push('circle_agent: database must be an object');
    else {
      ownFields(metadata.database, ['path', 'sha256', 'schema_source', 'semantic_canary'], 'circle_agent.database', errors);
      validateLocator(metadata.database.path, 'circle_agent.database.path', errors);
      validateLocator(metadata.database.schema_source, 'circle_agent.database.schema_source', errors);
    }
  } else {
    const hostRuntime = label === 'hermes' ? metadata.platform?.python : metadata.platform?.node;
    if (metadata.platform?.os_version !== '14' || !/^\d+\.\d+\.\d+$/.test(hostRuntime || '')) errors.push(`${label}: platform must pin exact os_version and host runtime patch`);
    const artifactKeys = label === 'hermes' ? ['root/state.db', 'native/hermes-backup.zip'] : ['state/openclaw.sqlite', 'native/openclaw-backup.tar.gz'];
    if (!isRecord(metadata.artifacts)) errors.push(`${label}: artifacts must be an object`);
    else {
      ownFields(metadata.artifacts, artifactKeys, `${label}.artifacts`, errors);
      for (const artifact of Object.keys(metadata.artifacts)) validateLocator(artifact, `${label}.artifacts`, errors);
    }
    if (!isRecord(metadata.native_archive_integrity)) errors.push(`${label}: native_archive_integrity must be an object`);
    else ownFields(metadata.native_archive_integrity, ['members', 'membership_sha256'], `${label}.native_archive_integrity`, errors);
    const observationKeys = label === 'hermes'
      ? ['includes_cache_logs', 'includes_import_preserved_runtime_state', 'excludes_dependencies_checkpoints_and_pids']
      : ['has_native_restore', 'includes_workspace_git_directory', 'encodes_absolute_source_paths', 'manifest_has_per_file_checksums'];
    if (!isRecord(metadata.native_archive_observations)) errors.push(`${label}: native_archive_observations must be an object`);
    else ownFields(metadata.native_archive_observations, observationKeys, `${label}.native_archive_observations`, errors);
  }
  if (!isRecord(metadata.tree_integrity) || Object.keys(metadata.tree_integrity).sort(lexical).join(',') !== 'algorithm,digest,files') errors.push(`${label}: tree_integrity must strictly declare algorithm, digest, and files`);
  const declaredFiles = Array.isArray(metadata.tree_integrity?.files) ? metadata.tree_integrity.files : [];
  if (metadata.tree_integrity?.algorithm !== 'sha256' || !/^[a-f0-9]{64}$/.test(metadata.tree_integrity?.digest || '') || declaredFiles.some((file) => !text(file)) || new Set(declaredFiles).size !== declaredFiles.length) errors.push(`${label}: tree_integrity is invalid`);
  const validDeclaredFiles = declaredFiles.filter((file) => validateLocator(file, `${label}.tree_integrity.files`, errors));

  const diskEntries = await filesBelow(fixtureDir);
  const sourceEntries = diskEntries.filter((entry) => entry.path !== 'fixture.json' && !entry.path.startsWith('native/'));
  const nativeEntries = diskEntries.filter((entry) => entry.path.startsWith('native/'));
  const diskFiles = sourceEntries.filter((entry) => entry.kind === 'file').map((entry) => entry.path);
  const observedFiles = [...new Set(diskFiles)].sort(lexical);
  for (const entry of sourceEntries.filter((item) => item.kind !== 'file')) errors.push(`${label}: unsupported observed source ${entry.kind}: ${entry.path}`);
  for (const addition of observedFiles.filter((file) => !validDeclaredFiles.includes(file))) errors.push(`${label}: unknown fixture addition fails closed: ${addition}`);
  for (const missing of validDeclaredFiles.filter((file) => !observedFiles.includes(file))) errors.push(`${label}: declared fixture source is missing: ${missing}`);
  const realDeclaredFiles = validDeclaredFiles.filter((file) => diskFiles.includes(file));
  if (realDeclaredFiles.length === validDeclaredFiles.length && validDeclaredFiles.length === declaredFiles.length) {
    const integrity = await calculateTree(fixtureDir, validDeclaredFiles);
    if (integrity.digest !== metadata.tree_integrity.digest) errors.push(`${label}: source tree integrity mismatch (expected ${metadata.tree_integrity.digest}, observed ${integrity.digest})`);
  }
  const accounted = validateExpectedClasses(metadata, observedFiles, label, errors);
  let scannedBytes = 0;
  for (const file of diskFiles) {
    const absolute = path.join(fixtureDir, file);
    if (!(await safeRegularFile(fixtureReal, absolute, `${label} source ${file}`, errors))) continue;
    const bytes = await fs.readFile(absolute);
    scannedBytes += bytes.length;
    if (bytes.length > MAX_FILE_BYTES || scannedBytes > MAX_TOTAL_BYTES) errors.push(`${label}: bounded fixture scan limit exceeded at ${file}`);
    else scanText(`${label} tree ${file}`, bytes, errors, { allowOpenClawSentinel: label === 'openclaw' && file === 'state/openclaw.json', allowDisposableRoot: label === 'openclaw' });
  }
  if (label === 'openclaw') {
    const configPath = path.join(fixtureDir, 'state/openclaw.json');
    if (await safeRegularFile(fixtureReal, configPath, 'openclaw state/openclaw.json', errors)) {
      const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      if (config?.gateway?.auth?.token !== OPENCLAW_SENTINEL) errors.push(`openclaw: the only permitted fixture token is the exact documented sentinel at state/openclaw.json#/gateway/auth/token`);
    }
  }
  if (label === 'hermes') {
    for (const credential of ['root/.env', 'root/profiles/research/.env']) {
      const credentialPath = path.join(fixtureDir, credential);
      if (!(await safeRegularFile(fixtureReal, credentialPath, `hermes credential ${credential}`, errors))) continue;
      const lines = (await fs.readFile(credentialPath, 'utf8')).split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#'));
      if (lines.length) errors.push(`hermes: credential fixture ${credential} must contain comments only`);
    }
    const authPath = path.join(fixtureDir, 'root/auth.json');
    if (await safeRegularFile(fixtureReal, authPath, 'hermes credential root/auth.json', errors)) {
      const auth = JSON.parse(await fs.readFile(authPath, 'utf8'));
      if (!isRecord(auth) || Object.keys(auth).length) errors.push('hermes: credential fixture root/auth.json must remain an empty object');
    }
  }
  let nativeArchive = null;
  const artifacts = metadata.artifacts || (metadata.database ? { [metadata.database.path]: `sha256:${metadata.database.sha256}` } : {});
  const listedNative = new Set(Object.keys(artifacts).filter((item) => item.startsWith('native/')));
  const nativeKinds = new Map(nativeEntries.map((entry) => [entry.path, entry.kind]));
  for (const entry of nativeEntries) {
    if (entry.kind !== 'file') errors.push(`${label}: native artifact ${entry.path} has unsupported kind ${entry.kind}`);
    else if (!listedNative.has(entry.path)) errors.push(`${label}: unlisted native artifact fails closed: ${entry.path}`);
  }
  for (const [artifact, digest] of Object.entries(artifacts)) {
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) { errors.push(`${label}: artifact ${artifact} has invalid sha256 pin`); continue; }
    if (!validateLocator(artifact, `${label}.artifact`, errors)) continue;
    if (nativeKinds.has(artifact) && nativeKinds.get(artifact) !== 'file') continue;
    if (artifact.startsWith('native/')) {
      nativeArchive = await validateArchive(label, fixtureDir, artifact, digest, errors);
      if (nativeArchive && (metadata.native_archive_integrity.members !== nativeArchive.members || metadata.native_archive_integrity.membership_sha256 !== nativeArchive.membership_sha256)) errors.push(`${label}: native archive membership evidence drifted`);
    }
    else {
      const absolute = path.join(fixtureDir, artifact);
      if (!(await safeRegularFile(fixtureReal, absolute, `${label} artifact ${artifact}`, errors))) continue;
      try { if (`sha256:${sha256(await fs.readFile(absolute))}` !== digest) errors.push(`${label}: artifact integrity mismatch for ${artifact}`); }
      catch { errors.push(`${label}: artifact ${artifact} is missing`); }
    }
  }
  return {
    runtime_family: label,
    runtime_version: metadata.runtime_version,
    ...(label === 'hermes' ? { qualification_scope: metadata.qualification_scope } : {}),
    discovered_sources: sourceEntries.length,
    accounted_sources: Math.min(accounted, sourceEntries.length),
    unsupported_sources: sourceEntries.filter((entry) => entry.kind !== 'file').length,
    native_archive: nativeArchive,
  };
}

export async function validateRuntimeAdapterFixtures(options = {}) {
  const errors = [];
  if (!isRecord(options) || !text(options.fixture_root) || !path.isAbsolute(options.fixture_root)) throw new TypeError('fixture_root must be an absolute fixture directory');
  let rootStat;
  try { rootStat = await fs.lstat(options.fixture_root); } catch { throw new TypeError('fixture_root does not exist or is not accessible'); }
  if (rootStat.isSymbolicLink()) throw new TypeError('fixture_root must not be a symlink');
  if (!rootStat.isDirectory()) throw new TypeError('fixture_root must be a directory');
  const optionFields = Object.keys(options).filter((key) => key !== 'fixture_root');
  if (optionFields.length) throw new TypeError(`fixture validation options contain unsupported fields: ${optionFields.sort(lexical).join(', ')}`);
  const fixtures = [];
  for (const relative of FIXTURES) fixtures.push(await validateFixture(options.fixture_root, relative, errors));
  const syntheticPath = path.join(options.fixture_root, 'synthetic/security/cases.json');
  try {
    const rootReal = await fs.realpath(options.fixture_root);
    if (!(await safeRegularFile(rootReal, syntheticPath, 'synthetic_security cases.json', errors))) throw new Error('cases.json is not a contained regular file');
    const synthetic = JSON.parse(await fs.readFile(syntheticPath, 'utf8'));
    ownFields(synthetic, ['fixture_version', 'cases'], 'synthetic_security', errors);
    if (synthetic.fixture_version !== 1 || !Array.isArray(synthetic.cases) || synthetic.cases.length === 0) errors.push('synthetic_security: fixture_version/cases are invalid');
    const ids = new Set();
    for (const [index, entry] of (synthetic.cases || []).entries()) {
      if (!isRecord(entry) || !text(entry.id) || !text(entry.kind) || !text(entry.path) || !CLASS_SET.has(entry.expected)) errors.push(`synthetic_security: cases[${index}] is invalid`);
      else if (ids.has(entry.id)) errors.push(`synthetic_security: duplicate case id ${entry.id}`);
      else ids.add(entry.id);
    }
    if (findRawSecretViolations(synthetic).length) errors.push('synthetic_security: fixture contains raw secret material');
    fixtures.push({ runtime_family: 'synthetic_security', runtime_version: '1', discovered_sources: synthetic.cases?.length || 0, accounted_sources: synthetic.cases?.length || 0, native_archive: null });
  } catch (error) { errors.push(`synthetic_security: cases.json is invalid or missing: ${error.message}`); }
  errors.sort(lexical);
  return jsonClone({ report_version: '1.0.0-draft', matrix_revision: matrix.revision, ok: errors.length === 0, errors, fixtures });
}

export function serializeFixtureDriftReport(report) {
  if (!isRecord(report)) throw new TypeError('fixture drift report must be an object');
  const serialized = `${canonical(report)}\n`;
  if (MACHINE_PATH_RE.test(serialized)) throw new TypeError('fixture drift report contains a machine-specific path');
  if (findRawSecretViolations({ content: serialized }).length) throw new TypeError('fixture drift report contains raw secret material');
  return serialized;
}
