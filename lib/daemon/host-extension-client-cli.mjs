import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runHostExtensionClientDryRun } from './host-extension-client.mjs';

const USAGE = 'Usage: agentbootup host-extension dry-run [--json]\n       agentbootup host-extension serve --module <local-module> [--jsonl]';

function boundedEnvelope(command, startedAt, { data, error } = {}) {
  const envelope = { success: !error, command: `host-extension ${command}`, durationMs: Date.now() - startedAt, mode: 'json' };
  if (error) envelope.error = error; else envelope.data = data;
  return envelope;
}
function jsonlWriter(io) {
  let sequence = 0;
  return (event, data) => io.stdout(JSON.stringify({ version: 1, sequence: sequence++, timestamp: new Date().toISOString(), event, data }));
}
function human(io, message) { io.stderr(message); }
function failure(io, mode, command, startedAt, code, message, emit) {
  const error = { message, code, exitCode: code === 'usage' ? 2 : 1, retryable: false };
  if (mode === 'json') io.stdout(JSON.stringify(boundedEnvelope(command, startedAt, { error })));
  else if (mode === 'jsonl') emit('error', error);
  else human(io, message);
  return error.exitCode;
}

/** Parse the deliberately small public surface without interpreting service policy. */
export function parseHostExtensionCliArgs(args) {
  const machine = Array.isArray(args) && args.includes('--jsonl') ? 'jsonl' : Array.isArray(args) && args.includes('--json') ? 'json' : 'human';
  if (!Array.isArray(args) || args.length === 0) return { error: 'missing command', mode: machine };
  const [command, ...rest] = args;
  if (command === 'dry-run') {
    if (rest.length === 0) return { command, mode: 'human' };
    if (rest.length === 1 && rest[0] === '--json') return { command, mode: 'json' };
    return { error: 'dry-run accepts only --json', mode: machine };
  }
  if (command !== 'serve') return { error: `unknown command "${command}"`, mode: machine };
  let modulePath; let mode = 'human';
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--json' || token === '--jsonl') {
      if (mode !== 'human') return { error: `duplicate or conflicting ${token}`, mode: machine };
      mode = token === '--jsonl' ? 'jsonl' : 'json'; continue;
    }
    if (token === '--module') {
      if (modulePath !== undefined) return { error: 'duplicate --module', mode: machine };
      const value = rest[++index];
      if (!value || value.startsWith('--')) return { error: '--module requires a local module path', mode: machine };
      modulePath = value; continue;
    }
    return { error: `unknown argument "${token}"`, mode: machine };
  }
  if (mode === 'json') return { error: 'serve is a stream; use --jsonl instead of --json', mode };
  if (modulePath === undefined) return { error: 'serve requires --module <local-module>', mode: machine };
  return { command, modulePath, mode };
}

/** Resolve only a normal local filesystem path; remote/data/node specifiers are never modules. */
export async function resolveLocalHostExtensionModule(modulePath, { cwd = process.cwd(), lstatImpl = lstat, realpathImpl = realpath } = {}) {
  if (typeof modulePath !== 'string' || modulePath.length === 0 || modulePath.includes('\0')
    || /^[a-z][a-z0-9+.-]*:/i.test(modulePath) || (path.isAbsolute(modulePath) === false && !modulePath.startsWith('.'))) {
    throw new Error('module must be an absolute or relative local file path');
  }
  const candidate = path.resolve(cwd, modulePath);
  const parsed = path.parse(candidate); const components = candidate.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root; let info;
  try {
    for (const component of components) {
      current = path.join(current, component); info = await lstatImpl(current);
      if (info.isSymbolicLink()) throw new Error('module path must not traverse symbolic links');
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'module path must not traverse symbolic links') throw error;
    throw new Error('module path does not exist or is not readable');
  }
  if (!info.isFile()) throw new Error('module path must identify a regular file');
  return realpathImpl(candidate);
}

function installerFromModule(moduleNamespace) {
  const installer = typeof moduleNamespace?.installHostExtensions === 'function' ? moduleNamespace.installHostExtensions
    : typeof moduleNamespace?.default === 'function' ? moduleNamespace.default : null;
  if (!installer) throw new Error('module must export installHostExtensions or a default function');
  return installer;
}

/** Starts the existing managed daemon with an explicit local installer module. */
export async function runHostExtensionClientCli(args, io, {
  cwd = process.cwd(), resolveModule = resolveLocalHostExtensionModule,
  importModule = (filePath) => import(pathToFileURL(filePath).href), startManagedDaemon,
} = {}) {
  const startedAt = Date.now(); const parsed = parseHostExtensionCliArgs(args); const emit = jsonlWriter(io);
  if (parsed.error) return failure(io, parsed.mode, parsed.command ?? args?.[0] ?? 'unknown', startedAt, 'usage', `${parsed.error}\n${USAGE}`, emit);
  if (parsed.command === 'dry-run') {
    const data = await runHostExtensionClientDryRun();
    if (parsed.mode === 'json') io.stdout(JSON.stringify(boundedEnvelope('dry-run', startedAt, { data })));
    else io.stdout(JSON.stringify(data));
    return 0;
  }
  try {
    const filePath = await resolveModule(parsed.modulePath, { cwd }); const installer = installerFromModule(await importModule(filePath));
    const starter = startManagedDaemon ?? (await import('./brain-asset-sync.mjs')).startManagedBrainAssetSync;
    if (typeof starter !== 'function') throw new Error('managed daemon starter is unavailable');
    const report = (event, data) => parsed.mode === 'jsonl' ? emit(event, data) : io.stdout(`${event}: ${data.message ?? data.outcome ?? ''}`);
    const reportingInstaller = async (client) => {
      try {
        return await installer(Object.freeze({
          register(options = {}) {
            const originalReceipt = options.onTerminalReceipt;
            const result = client.register({ ...options, onTerminalReceipt(receipt) {
              const outcome = receipt?.disposition === 'delivered' ? 'delivered' : receipt?.disposition === 'endpoint_rejected' ? 'rejected_before_delivery' : 'delivery_uncertain';
              report('terminal', { outcome, serviceId: options.serviceId, correlationId: receipt?.correlationId, evidence: 'transport_delivery_only' });
              if (typeof originalReceipt === 'function') { try { originalReceipt(receipt); } catch { /* service callback cannot destabilize relay */ } }
            } });
            report('registration', { outcome: result.outcome, serviceId: options.serviceId, message: `Registration ${result.outcome} for ${options.serviceId}` });
            return result;
          },
        }));
      } catch (error) {
        report('installer_error', { message: `host-extension installer failed: ${error instanceof Error ? error.message : String(error)}`, code: 'installer_failure' });
        throw error;
      }
    };
    report('starting', { module: filePath, message: `Starting host-extension daemon from ${filePath}` });
    await starter({ installHostExtensions: reportingInstaller, logImpl: (message) => human(io, message), logErrorImpl: (message, error) => human(io, `${message}${error ? `: ${error.message}` : ''}`) });
    return 0;
  } catch (error) { return failure(io, parsed.mode, 'serve', startedAt, 'internal', `host-extension serve failed: ${error instanceof Error ? error.message : String(error)}`, emit); }
}
