import fsp from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { inspectCredentials, CREDS_STATE_OK, formatCredentialsRecoveryMessage } from '../../auth/credentials.js';
import { apiUrl, isValidServerUrl } from '../../auth/validate.js';
import { CLI_TRANSCRIPT_SOURCES, discoverTranscriptInventory } from '../../brain/transcript-discovery.js';
import { buildDenylist } from '../../daemon/redaction-denylist.js';
import { getMachineId } from '../../machine-id/machine-id.js';
import { resolveProjectAgentId } from '../../project-config.js';
import { redactContent } from '../../runtime-adapters/redaction.js';
import { readStableSnapshot } from '../../transcript-archive/snapshot.js';

const VALID_CLIS = new Set(['claude', 'codex', 'cursor', 'gemini']);
const VALID_SINCE_BASES = new Set(['mtime', 'session', 'key']);
const MAX_REPUSH_BYTES = 4 * 1024 * 1024;
const MAX_LOCAL_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_JSON_RESPONSE_BYTES = 16 * 1024 * 1024;
const CAVEAT = 'Mitigation only: v1 overwrite is capped at 4 MiB (about 1 of 13 known July 2026 leaked objects); it does not retract downstream ingest, backups, or snapshots. Key rotation is the only remediation.';
const ISO_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const REMOTE_UPDATED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

async function defaultConfirm(message) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
  const prompt = readline.createInterface({ input: process.stdin, output: process.stderr });
  try { return /^y(?:es)?$/i.test((await prompt.question(`${message} [y/N] `)).trim()); }
  finally { prompt.close(); }
}

export function mitigateRemoteCopyUsage() {
  return [
    'Usage: agentbootup transcripts mitigate-remote-copy --redact [--repush] [--yes]',
    '       [--cli <claude|codex|cursor|gemini>] [--cwd <project>]',
    '       [--since <ISO timestamp>] [--since-basis <mtime|session|key>]',
    '       [--snapshot-root <absolute path>]',
    '',
    'Without --repush, writes mode-0600 copies below ~/.agentbootup/redacted-snapshots.',
    'With --repush, lists and validates exact remote keys before asking for confirmation.',
    '`key` means the remote object updated_at timestamp; it is not session chronology.',
    CAVEAT,
  ].join('\n');
}

class UsageError extends Error {}

export function parseMitigateRemoteCopyArgs(argv) {
  const parsed = {
    help: false, redact: false, repush: false, yes: false, cli: null,
    cwd: process.cwd(), since: null, sinceBasis: 'mtime', snapshotRoot: null,
  };
  let sinceBasisExplicit = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--redact') parsed.redact = true;
    else if (arg === '--repush') parsed.repush = true;
    else if (arg === '--yes') parsed.yes = true;
    else if (['--cli', '--cwd', '--since', '--since-basis', '--snapshot-root'].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new UsageError(`${arg} requires a value`);
      if (arg === '--cli') parsed.cli = value;
      else if (arg === '--cwd') parsed.cwd = value;
      else if (arg === '--since') parsed.since = value;
      else if (arg === '--since-basis') { parsed.sinceBasis = value; sinceBasisExplicit = true; }
      else parsed.snapshotRoot = value;
    } else throw new UsageError(`unknown mitigate-remote-copy option: ${arg}`);
  }
  if (parsed.help) return parsed;
  if (!parsed.redact) throw new UsageError('mitigate-remote-copy requires --redact');
  if (parsed.cli && !VALID_CLIS.has(parsed.cli)) throw new UsageError(`unsupported transcript CLI: ${parsed.cli}`);
  if (!VALID_SINCE_BASES.has(parsed.sinceBasis)) throw new UsageError('--since-basis must be mtime, session, or key');
  if (sinceBasisExplicit && !parsed.since) throw new UsageError('--since-basis requires --since');
  if (parsed.since) {
    const calendar = ISO_INSTANT_RE.exec(parsed.since);
    const timestamp = Date.parse(parsed.since);
    if (!calendar || !Number.isFinite(timestamp)) throw new UsageError('--since must be an ISO date or timestamp');
    const calendarCheck = new Date(Date.UTC(Number(calendar[1]), Number(calendar[2]) - 1, Number(calendar[3])));
    if (calendarCheck.getUTCFullYear() !== Number(calendar[1]) || calendarCheck.getUTCMonth() + 1 !== Number(calendar[2])
      || calendarCheck.getUTCDate() !== Number(calendar[3])) {
      throw new UsageError('--since must be an ISO date or timestamp');
    }
    parsed.since = new Date(timestamp);
  }
  parsed.cwd = path.resolve(parsed.cwd);
  if (parsed.snapshotRoot) parsed.snapshotRoot = path.resolve(parsed.snapshotRoot);
  return parsed;
}

function safeIdentifier(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') {
    throw new Error(`${name} is not a safe identifier`);
  }
  return value;
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value)) {
    throw new Error('transcript relative path is unsafe');
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error('transcript relative path is unsafe');
  return parts.join('/');
}

export function expectedTranscriptKey({ brainId, machineId, cli, relativePath }) {
  return `transcripts/${safeIdentifier(brainId, 'brain ID')}/${safeIdentifier(machineId, 'machine ID')}/${safeIdentifier(cli, 'CLI')}/${safeRelativePath(relativePath)}`;
}

function formatForFile(file) {
  const extension = path.extname(file.filename || file.path).toLowerCase();
  return extension === '.txt' ? 'text' : extension === '.json' ? 'json' : 'jsonl';
}

function mtimeMilliseconds(snapshot) {
  const nanoseconds = BigInt(snapshot.before.mtimeNs);
  return Number(nanoseconds / 1_000_000n);
}

export function mitigationSinceTimestamp(basis, { snapshot, content, remoteUpdatedAt }) {
  if (basis === 'mtime') return mtimeMilliseconds(snapshot);
  if (basis === 'session') return lastSessionTimestamp(content);
  if (basis === 'key') {
    const timestamp = Date.parse(remoteUpdatedAt ?? '');
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  throw new TypeError('unknown mitigation since basis');
}

export function lastSessionTimestamp(content) {
  const candidates = [];
  const visit = (value, depth = 0) => {
    if (depth > 100 || value == null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (['timestamp', 'created_at', 'createdAt', 'updated_at', 'updatedAt'].includes(key)) {
        const timestamp = typeof child === 'number' && Number.isFinite(child)
          ? (child < 10_000_000_000 ? child * 1000 : child)
          : Date.parse(String(child));
        if (Number.isFinite(timestamp)) candidates.push(timestamp);
      }
      visit(child, depth + 1);
    }
  };
  try {
    visit(JSON.parse(content));
  } catch {
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try { visit(JSON.parse(line)); } catch { /* redaction separately fails closed on suspicious malformed content */ }
    }
  }
  return candidates.length ? Math.max(...candidates) : null;
}

function categoryCounter() {
  const counts = { env: 0, denylist: 0, exact: 0, heuristic: 0 };
  return { counts, record: (category) => { if (Object.hasOwn(counts, category)) counts[category] += 1; } };
}

function snapshotDestination(snapshotRoot, item) {
  const relative = safeRelativePath(item.file.relative_path);
  const extension = path.posix.extname(relative);
  const stem = extension ? relative.slice(0, -extension.length) : relative;
  const destination = path.resolve(
    snapshotRoot,
    safeIdentifier(item.brainId, 'brain ID'),
    safeIdentifier(item.machineId, 'machine ID'),
    safeIdentifier(item.file.cli, 'CLI'),
    `${stem}.redacted${extension}`,
  );
  const relation = path.relative(path.resolve(snapshotRoot), destination);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) throw new Error('snapshot destination escaped its root');
  return destination;
}

async function writeSnapshot(item, snapshotRoot, deps) {
  for (const watchedRoot of item.watchedRoots) {
    const relation = path.relative(path.resolve(watchedRoot), path.resolve(snapshotRoot));
    if (!relation || (!relation.startsWith('..') && !path.isAbsolute(relation))) {
      throw new Error('redacted snapshot root must be outside every watched transcript root');
    }
  }
  const destination = snapshotDestination(snapshotRoot, item);
  const rootGuard = await ensureProtectedDirectory(snapshotRoot, deps.fsp);
  const realSnapshotRoot = await deps.fsp.realpath(snapshotRoot);
  for (const watchedRoot of item.watchedRoots) {
    let realWatchedRoot;
    try { realWatchedRoot = await deps.fsp.realpath(watchedRoot); }
    catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    const relation = path.relative(realWatchedRoot, realSnapshotRoot);
    if (!relation || (!relation.startsWith('..') && !path.isAbsolute(relation))) {
      throw new Error('redacted snapshot root resolves inside a watched transcript root');
    }
  }
  const destinationGuard = await ensureProtectedDirectory(path.dirname(destination), deps.fsp, snapshotRoot);
  await revalidateDirectoryChains(deps.fsp, rootGuard, destinationGuard);
  const temporary = `${destination}.${process.pid}.tmp`;
  const handle = await deps.fsp.open(
    temporary,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await revalidateDirectoryChains(deps.fsp, rootGuard, destinationGuard);
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error('snapshot temporary file is not protected');
    await handle.writeFile(item.cleanContent, 'utf8');
    await handle.sync();
    await handle.close();
    await deps.fsp.rename(temporary, destination);
    await revalidateDirectoryChains(deps.fsp, rootGuard, destinationGuard);
    const directory = await deps.fsp.open(path.dirname(destination), fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    try { await directory.sync(); }
    finally { await directory.close(); }
  } catch (error) {
    await handle.close().catch(() => {});
    await deps.fsp.unlink(temporary).catch(() => {});
    throw error;
  }
  return destination;
}

async function ensureProtectedDirectory(directory, fsApi, protectedRoot = directory) {
  const absolute = path.resolve(directory);
  const root = path.resolve(protectedRoot);
  if (absolute !== root) {
    const relation = path.relative(root, absolute);
    if (relation.startsWith('..') || path.isAbsolute(relation)) throw new Error('snapshot directory escaped its protected root');
  }
  const filesystemRoot = path.parse(root).root;
  const rootParts = path.relative(filesystemRoot, root).split(path.sep).filter(Boolean);
  const protectedParts = path.relative(root, absolute).split(path.sep).filter(Boolean);
  const guard = [];
  let current = filesystemRoot;
  guard.push(await inspectSnapshotAncestor(current, fsApi, rootParts.length === 0));
  for (const [index, component] of rootParts.entries()) {
    current = path.join(current, component);
    await createSnapshotDirectoryIfMissing(current, fsApi);
    guard.push(await inspectSnapshotAncestor(current, fsApi, index === rootParts.length - 1));
  }
  for (const component of protectedParts) {
    current = path.join(current, component);
    await createSnapshotDirectoryIfMissing(current, fsApi);
    guard.push(await inspectSnapshotAncestor(current, fsApi, true));
  }
  return guard;
}

async function createSnapshotDirectoryIfMissing(directory, fsApi) {
  try {
    await fsApi.lstat(directory);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    try { await fsApi.mkdir(directory, { mode: 0o700 }); }
    catch (mkdirError) { if (mkdirError?.code !== 'EEXIST') throw mkdirError; }
  }
}

async function inspectSnapshotAncestor(directory, fsApi, protectedDirectory) {
  const stat = await fsApi.lstat(directory);
  if (stat.isSymbolicLink()) {
    if (protectedDirectory || stat.uid !== 0) {
      throw new Error('snapshot path ancestors must be non-symlink directories');
    }
    const targetStat = await fsApi.stat(directory);
    if (!targetStat.isDirectory() || (targetStat.mode & 0o022) !== 0 || targetStat.uid !== 0) {
      throw new Error('snapshot path contains an untrusted system symlink');
    }
    return { directory, dev: stat.dev, ino: stat.ino, symbolicLink: true };
  }
  if (!stat.isDirectory()) {
    throw new Error('snapshot path ancestors must be non-symlink directories');
  }
  const mode = stat.mode & 0o7777;
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (protectedDirectory) {
    if ((mode & 0o777) !== 0o700) throw new Error('snapshot directories must have mode 0700');
    if (currentUid !== null && stat.uid !== currentUid) throw new Error('snapshot directories must be owned by the current user');
  } else if ((mode & 0o022) !== 0) {
    const trustedStickyDirectory = (mode & 0o1000) !== 0
      && (currentUid === null || stat.uid === 0 || stat.uid === currentUid);
    if (!trustedStickyDirectory) throw new Error('snapshot path has an untrusted writable ancestor');
  }
  return { directory, dev: stat.dev, ino: stat.ino, symbolicLink: false };
}

async function revalidateDirectoryChains(fsApi, ...chains) {
  const seen = new Set();
  for (const entry of chains.flat()) {
    if (seen.has(entry.directory)) continue;
    seen.add(entry.directory);
    const stat = await fsApi.lstat(entry.directory);
    if (stat.isSymbolicLink() !== entry.symbolicLink || (!entry.symbolicLink && !stat.isDirectory())
      || stat.dev !== entry.dev || stat.ino !== entry.ino) {
      throw new Error('snapshot path changed during publication');
    }
  }
}

async function readBoundedResponse(response, limit, message) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => {});
    throw new Error(message);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel().catch(() => {});
      throw new Error(message);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, bytes);
}

async function readJsonResponse(response) {
  const encoded = await readBoundedResponse(
    response, MAX_JSON_RESPONSE_BYTES, 'remote JSON response exceeds the configured limit',
  );
  let body = null;
  try { body = JSON.parse(encoded.toString('utf8')); } catch { body = null; }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return body;
}

async function listRemote(deps, credentials, brainId, machineId, cli) {
  const query = new URLSearchParams({ brain_id: brainId, machine_id: machineId });
  if (cli) query.set('cli', cli);
  const response = await deps.fetch(`${apiUrl(credentials.serverUrl, '/v1/sync/transcripts/pull')}?${query}`, {
    headers: { Authorization: `Bearer ${credentials.apiKey}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await readJsonResponse(response);
  if (!Array.isArray(body?.data?.files)) throw new Error('remote transcript list response is invalid');
  if (!Number.isSafeInteger(body?.data?.total) || body.data.total < 0 || body.data.total !== body.data.files.length) {
    throw new Error('remote transcript inventory is incomplete');
  }
  const keys = new Set();
  for (const meta of body.data.files) {
    if (typeof meta?.key !== 'string' || !meta.key) throw new Error('remote transcript metadata has an invalid key');
    if (keys.has(meta.key)) throw new Error(`remote transcript inventory contains duplicate key: ${meta.key}`);
    keys.add(meta.key);
  }
  return body.data.files;
}

function exactRemoteMeta(meta, item) {
  return meta?.key === item.key && meta?.brain_id === item.brainId && meta?.machine_id === item.machineId
    && meta?.cli === item.file.cli && meta?.relative_path === item.file.relative_path
    && Number.isSafeInteger(meta?.size) && meta.size >= 0
    && typeof meta?.updated_at === 'string' && REMOTE_UPDATED_AT_RE.test(meta.updated_at)
    && Number.isFinite(Date.parse(meta.updated_at));
}

async function pushAndVerify(item, credentials, deps) {
  const redactedBytes = Buffer.from(item.cleanContent, 'utf8');
  if (redactedBytes.byteLength > MAX_REPUSH_BYTES) throw new Error('redacted transcript exceeds the 4 MiB v1 mitigation cap');
  const file = {
    filename: item.file.filename,
    relative_path: item.file.relative_path,
    cli: item.file.cli,
    chunk_index: 0,
    total_chunks: 1,
    byte_offset: 0,
    total_size: redactedBytes.byteLength,
    content_base64: redactedBytes.toString('base64'),
  };
  const response = await deps.fetch(apiUrl(credentials.serverUrl, '/v1/sync/transcripts/push'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${credentials.apiKey}` },
    body: JSON.stringify({ brain_id: item.brainId, machine_id: item.machineId, cli: item.file.cli, files: [file] }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await readJsonResponse(response);
  const result = body?.data?.results?.find((candidate) => candidate?.key === item.key);
  if (!['pushed', 'appended'].includes(result?.status)) throw new Error('push response did not confirm the exact transcript key');

  const readback = await deps.fetch(
    `${apiUrl(credentials.serverUrl, '/v1/sync/transcripts/download')}/${encodeURIComponent(item.key)}`,
    { headers: { Authorization: `Bearer ${credentials.apiKey}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  if (!readback.ok) throw new Error(`readback HTTP ${readback.status}`);
  const bytes = await readBoundedResponse(readback, MAX_REPUSH_BYTES, 'readback exceeds the v1 mitigation cap');
  if (!bytes.equals(redactedBytes)) throw new Error('readback bytes do not match the proven-clean redacted payload');
  for (const value of [...item.denylist.values, ...item.denylist.derivedValues]) {
    if (value && bytes.includes(Buffer.from(value))) throw new Error('readback still contains a denylist value');
  }
  return result.status;
}

function printReport(io, item, status, destination = null) {
  io.stdout(JSON.stringify({
    key: item.key,
    cli: item.file.cli,
    original_bytes: item.originalBytes,
    redacted_bytes: Buffer.byteLength(item.cleanContent),
    replacements: item.categories,
    push_status: status,
    readback_verified_clean: status === 'pushed' || status === 'appended',
    ...(destination ? { snapshot: destination } : {}),
  }));
}

export async function runMitigateRemoteCopy(argv, io = { stdout: console.log, stderr: console.error }, injected = {}) {
  let options;
  try { options = parseMitigateRemoteCopyArgs(argv); }
  catch (error) { io.stderr(error.message); io.stderr(mitigateRemoteCopyUsage()); return 2; }
  if (options.help) { io.stdout(mitigateRemoteCopyUsage()); return 0; }

  const deps = {
    inspectCredentials, discoverTranscriptInventory, buildDenylist, getMachineId,
    resolveProjectAgentId, readStableSnapshot, redactContent, fetch: globalThis.fetch,
    confirm: defaultConfirm, fsp, homeDir: os.homedir(),
    transcriptSourceRoots: CLI_TRANSCRIPT_SOURCES.map((source) => source.rootFn()),
    ...injected,
  };
  try {
    const brainId = deps.resolveProjectAgentId(options.cwd);
    const machineId = await deps.getMachineId();
    const inventory = await deps.discoverTranscriptInventory({ projectRoot: options.cwd });
    if (!inventory || !Array.isArray(inventory.files) || !Array.isArray(inventory.discoveryFailures)) {
      throw new Error('transcript discovery returned an invalid result');
    }
    if (inventory.discoveryFailures.length) throw new Error('transcript discovery was incomplete; refusing partial mitigation');
    const files = options.cli ? inventory.files.filter((file) => file.cli === options.cli) : inventory.files;
    const projectRoots = [options.cwd];
    const denylist = deps.buildDenylist(projectRoots);
    if (denylist.state === 'failed') throw new Error(`denylist unavailable: ${denylist.errorCode}`);

    let credentials = null;
    if (options.repush || options.sinceBasis === 'key') {
      const credentialState = await deps.inspectCredentials();
      if (credentialState?.state !== CREDS_STATE_OK) throw new Error(formatCredentialsRecoveryMessage(credentialState));
      credentials = credentialState.creds;
      if (!isValidServerUrl(credentials.serverUrl)) throw new Error('credentials contain an invalid server URL');
    }

    const remoteFiles = credentials
      ? await listRemote(deps, credentials, brainId, machineId, options.cli)
      : [];
    const remoteByKey = new Map(remoteFiles.map((meta) => [meta.key, meta]));
    const items = [];
    let incomplete = 0;
    for (const file of files) {
      if (!VALID_CLIS.has(file.cli)) continue;
      const snapshot = await deps.readStableSnapshot(file.path, {
        trustedRoot: file.root, maxBytes: MAX_LOCAL_SNAPSHOT_BYTES,
      });
      const content = snapshot.buffer.toString('utf8');
      const key = expectedTranscriptKey({ brainId, machineId, cli: file.cli, relativePath: file.relative_path });
      const remoteMeta = remoteByKey.get(key);
      if (options.since) {
        const observed = mitigationSinceTimestamp(options.sinceBasis, {
          snapshot,
          content,
          remoteUpdatedAt: exactRemoteMeta(remoteMeta, { key, brainId, machineId, file })
            ? remoteMeta.updated_at : null,
        });
        if (!Number.isFinite(observed)) {
          io.stderr(`skipped ${key}: ${options.sinceBasis} timestamp unavailable`);
          incomplete += 1;
          continue;
        }
        if (observed < options.since.getTime()) continue;
      }
      const counter = categoryCounter();
      const redaction = deps.redactContent(content, {
        format: formatForFile(file), denylist: denylist.values, derivedDenylist: denylist.derivedValues,
        sourceMap: denylist.sourceMap, derivedSourceMap: denylist.derivedSourceMap,
        onReplacement: counter.record,
      });
      if (redaction.blocked) {
        io.stderr(`skipped ${key}: ${redaction.blockReason}`);
        incomplete += 1;
        continue;
      }
      items.push({
        file, key, brainId, machineId, denylist, cleanContent: redaction.cleanContent,
        originalBytes: snapshot.byteSize, categories: counter.counts,
        remoteMeta: exactRemoteMeta(remoteMeta, { key, brainId, machineId, file }) ? remoteMeta : null,
        watchedRoots: [...new Set([...deps.transcriptSourceRoots, ...files.map((entry) => entry.root)])],
      });
    }

    if (!options.repush) {
      const snapshotRoot = options.snapshotRoot ?? path.join(deps.homeDir, '.agentbootup', 'redacted-snapshots');
      for (const item of items) {
        const destination = await writeSnapshot(item, snapshotRoot, deps);
        printReport(io, item, 'snapshot_written', destination);
      }
      io.stdout(CAVEAT);
      return incomplete ? 1 : 0;
    }

    let mismatches = 0;
    let absentRemote = 0;
    let ineligibleRemote = 0;
    const repushItems = [];
    for (const item of items) {
      const suppliedMeta = remoteByKey.get(item.key);
      if (!suppliedMeta) { absentRemote += 1; continue; }
      if (!item.remoteMeta) { io.stderr(`remote metadata mismatch: ${item.key}`); mismatches += 1; continue; }
      if (Buffer.byteLength(item.cleanContent, 'utf8') > MAX_REPUSH_BYTES) {
        io.stderr(`ineligible (exceeds 4 MiB): ${item.key}`);
        ineligibleRemote += 1;
        continue;
      }
      repushItems.push(item);
      io.stdout(`would overwrite: ${item.key}`);
    }
    if (mismatches) { io.stderr('No remote writes performed because exact key matching failed.'); return 5; }
    if (absentRemote) io.stdout(`Excluded ${absentRemote} local transcript file(s) with no exact remote object.`);
    if (!repushItems.length) {
      io.stdout('No exact local/remote transcript intersections required mitigation.');
      io.stdout(CAVEAT);
      return incomplete || ineligibleRemote ? 1 : 0;
    }
    if (!options.yes && !(await deps.confirm(`Overwrite ${repushItems.length} exact remote transcript key(s)?`))) {
      io.stderr('Remote overwrite cancelled; pass --yes only after reviewing the key list.');
      return 2;
    }

    let failures = 0;
    for (const item of repushItems) {
      try {
        const currentRemote = await listRemote(deps, credentials, brainId, machineId, item.file.cli);
        const current = currentRemote.find((meta) => meta?.key === item.key);
        if (!exactRemoteMeta(current, item) || current.updated_at !== item.remoteMeta.updated_at || current.size !== item.remoteMeta.size) {
          throw new Error('remote key changed after review');
        }
        const status = await pushAndVerify(item, credentials, deps);
        printReport(io, item, status);
      } catch (error) {
        failures += 1;
        io.stderr(`failed ${item.key}: ${error.message}`);
      }
    }
    io.stdout(CAVEAT);
    return failures || incomplete || ineligibleRemote ? 1 : 0;
  } catch (error) {
    io.stderr(`mitigate-remote-copy failed: ${error.message}`);
    return 1;
  }
}
