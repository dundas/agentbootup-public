/**
 * CLI command handlers for `agentbootup auth login` and `agentbootup auth status`.
 *
 * Usage:
 *   agentbootup auth login --api-key <key> [--server-url <url>]
 *   agentbootup auth export --for-host <hostname> [--json]
 *   agentbootup auth import [--payload-file <path>]
 *   agentbootup auth status
 */

import fs from 'fs/promises';
import {
  writeCredentials,
  inspectCredentials,
  CREDS_STATE_OK,
  CREDS_FILE,
  formatCredentialsRecoveryMessage,
  exportCredentialsPayload,
  importCredentialsPayload,
  decryptLegacyWithHostname,
  parseCredentialsPlaintextForRewrap,
} from './credentials.js';
import { startDeviceAuth, pollDeviceAuth, tryOpenBrowser } from './device-login.js';
import { getCurrentRuntimeInfo, formatHandoffSupportMessage } from '../runtime-info.js';

const DEFAULT_SERVER_URL = 'https://agentbootup.fly.dev';
const CURRENT_RUNTIME = getCurrentRuntimeInfo(import.meta.url);

function printLoginUsage(io) {
  io.stderr('Usage: agentbootup auth login [--server-url <url>] [--no-browser]');
  io.stderr('       agentbootup auth login --api-key <key> [--server-url <url>]');
}

function printExportUsage(io) {
  io.stderr('Usage: agentbootup auth export --for-host <hostname> [--json]');
}

function printImportUsage(io) {
  io.stderr('Usage: agentbootup auth import [--payload-file <path>]');
  io.stderr('       cat handoff.json | agentbootup auth import');
}

function parseLoginArgs(args) {
  let apiKey = null;
  let serverUrl = DEFAULT_SERVER_URL;
  let noBrowser = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--api-key' && args[i + 1]) {
      apiKey = args[++i];
    } else if (args[i] === '--server-url' && args[i + 1]) {
      serverUrl = args[++i];
    } else if (args[i] === '--no-browser') {
      noBrowser = true;
    }
  }
  return { apiKey, serverUrl, noBrowser };
}

function getFlagValue(args, flag) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) {
      return args[i + 1];
    }
  }
  return null;
}

function validateServerUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Handle `agentbootup auth login [--server-url <url>] [--no-browser]`
 * or `agentbootup auth login --api-key <key> [--server-url <url>]`.
 *
 * Without --api-key, runs the interactive device-auth browser approval flow.
 *
 * @param {string[]} args - argv after `auth login`
 * @param {{ stdout: (line: string) => void, stderr: (line: string) => void }} io
 * @param {{ fetchImpl?: typeof fetch, openBrowser?: (url: string) => void }} [deps]
 */
export async function handleAuthLogin(args, io, deps = {}) {
  const { apiKey, serverUrl, noBrowser } = parseLoginArgs(args);

  if (!validateServerUrl(serverUrl)) {
    io.stderr(`Error: invalid --server-url "${serverUrl}"`);
    printLoginUsage(io);
    process.exitCode = 1;
    return;
  }

  if (!apiKey || apiKey.trim() === '') {
    if (apiKey !== null) {
      io.stderr('Note: --api-key was empty; starting interactive login instead.');
    }
    await handleInteractiveAuthLogin({ serverUrl, noBrowser, ...deps }, io);
    return;
  }

  try {
    await writeCredentials({ apiKey: apiKey.trim(), serverUrl });
    io.stdout('Credentials saved to ~/.agentbootup/credentials');
    io.stdout(`Server URL: ${serverUrl}`);
  } catch (err) {
    io.stderr(`Error saving credentials: ${err.message}`);
    process.exitCode = 1;
  }
}

/**
 * @param {{ serverUrl: string, noBrowser?: boolean, fetchImpl?: typeof fetch, openBrowser?: (url: string) => void }} options
 * @param {{ stdout: (line: string) => void, stderr: (line: string) => void }} io
 */
export async function handleInteractiveAuthLogin(options, io) {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const started = await startDeviceAuth(options.serverUrl, fetchImpl);
    io.stdout('Sign in with your ClearAuth account to authorize this CLI session.');
    io.stdout(`Verification URL: ${started.verificationUri}`);
    io.stdout(`User code: ${started.userCode}`);
    io.stdout('Approve the request in your browser, then return here to finish login.');

    if (!options.noBrowser) {
      const opened = tryOpenBrowser(started.verificationUri, { openBrowser: options.openBrowser });
      if (opened) {
        io.stdout('Opened the verification URL in your default browser.');
      } else {
        io.stderr('Could not open a browser automatically. Copy the verification URL above.');
      }
    }

    const approved = await pollDeviceAuth(options.serverUrl, started.deviceCode, {
      fetchImpl,
      intervalSeconds: started.intervalSeconds,
      expiresAtMs: Date.now() + started.expiresIn * 1000,
      onPending: () => {
        io.stdout('Waiting for browser approval...');
      },
      onAwaitingKey: () => {
        io.stdout('Approval received — waiting for API key...');
      },
    });

    await writeCredentials({ apiKey: approved.apiKey, serverUrl: options.serverUrl });
    io.stdout('Credentials saved to ~/.agentbootup/credentials');
    io.stdout(`Server URL: ${options.serverUrl}`);
    if (approved.keyId) {
      io.stdout(`Key ID: ${approved.keyId}`);
    }
  } catch (err) {
    io.stderr(`Interactive login failed: ${err.message}`);
    process.exitCode = 1;
  }
}

/**
 * Handle `agentbootup auth export --for-host <hostname> [--json]`.
 *
 * Emits a host-bound credential handoff payload for trusted local transport.
 *
 * @param {string[]} args
 * @param {{ stdout: (line: string) => void, stderr: (line: string) => void }} io
 */
export async function handleAuthExport(args, io) {
  const targetHostname = getFlagValue(args, '--for-host');
  if (!targetHostname || !targetHostname.trim()) {
    io.stderr('Error: --for-host is required');
    printExportUsage(io);
    process.exitCode = 1;
    return;
  }
  const normalizedTargetHostname = targetHostname.trim();

  const status = await inspectCredentials();
  if (status.state !== CREDS_STATE_OK) {
    io.stderr(
      formatCredentialsRecoveryMessage(status, {
        missingMessage: 'Not configured. Run: agentbootup auth login (or auth login --api-key <key>)',
      })
    );
    process.exitCode = 1;
    return;
  }
  const creds = status.creds;

  try {
    const payload = exportCredentialsPayload(creds, normalizedTargetHostname);
    io.stdout(payload);
  } catch (err) {
    io.stderr(`Error exporting credentials: ${err.message}`);
    process.exitCode = 1;
  }
}

async function readPayloadFromStdin(io) {
  if (typeof io.readStdin === 'function') {
    return io.readStdin();
  }

  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

/**
 * Handle `agentbootup auth import [--payload-file <path>]`.
 *
 * Accepts a host-bound credential handoff payload for the current host from
 * stdin by default, or from `--payload-file <path>` when provided, and writes
 * it to the normal encrypted credentials store.
 *
 * @param {string[]} args
 * @param {{ stdout: (line: string) => void, stderr: (line: string) => void }} io
 */
export async function handleAuthImport(args, io) {
  const payloadFile = getFlagValue(args, '--payload-file');

  let rawPayload = '';
  try {
    if (payloadFile && payloadFile.trim()) {
      rawPayload = await fs.readFile(payloadFile.trim(), 'utf8');
    } else {
      rawPayload = await readPayloadFromStdin(io);
    }
  } catch (err) {
    io.stderr(`Error importing credentials: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (!rawPayload || !rawPayload.trim()) {
    io.stderr('Error: credential payload is required via stdin or --payload-file');
    printImportUsage(io);
    process.exitCode = 1;
    return;
  }

  try {
    const creds = importCredentialsPayload(rawPayload);
    await writeCredentials(creds);
    io.stdout('Credentials imported to ~/.agentbootup/credentials');
    io.stdout(`Server URL: ${creds.serverUrl}`);
  } catch (err) {
    io.stderr(`Error importing credentials: ${err.message}`);
    process.exitCode = 1;
  }
}

/**
 * Handle `agentbootup auth status`.
 * Prints masked API key and server URL if configured; exits 1 if not.
 *
 * @param {{ stdout: (line: string) => void, stderr: (line: string) => void }} io
 */
export async function handleAuthStatus(io) {
  const status = await inspectCredentials();
  if (status.state !== CREDS_STATE_OK) {
    io.stderr(
      formatCredentialsRecoveryMessage(status, {
        missingMessage: 'Not configured. Run: agentbootup auth login (or auth login --api-key <key>)',
      })
    );
    process.exitCode = 1;
    return;
  }
  const creds = status.creds;
  const masked = creds.apiKey.length > 4
    ? `${creds.apiKey.slice(0, 4)}${'*'.repeat(Math.min(creds.apiKey.length - 4, 8))}`
    : '****';
  io.stdout(`API Key: ${masked}`);
  io.stdout(`Server URL: ${creds.serverUrl}`);
  io.stdout(formatHandoffSupportMessage(CURRENT_RUNTIME));
}

/**
 * Route `agentbootup auth <subcommand> [...args]`.
 *
 * @param {string[]} argv - full argv starting at the `auth` token
 * @param {{ stdout?: (line: string) => void, stderr?: (line: string) => void, readStdin?: () => Promise<string> }} [options]
 */
export async function runAuthCommand(argv, options = {}) {
  const io = {
    stdout: options.stdout ?? ((line) => console.log(line)),
    stderr: options.stderr ?? ((line) => console.error(line)),
    readStdin: options.readStdin,
  };

  const subcommand = argv[1] ?? '';
  const rest = argv.slice(2);

  switch (subcommand) {
    case 'login':
      await handleAuthLogin(rest, io);
      break;
    case 'export':
      await handleAuthExport(rest, io);
      break;
    case 'import':
      await handleAuthImport(rest, io);
      break;
    case 'status':
      await handleAuthStatus(io);
      break;
    case 'rewrap':
      await handleAuthRewrap(rest, io);
      break;
    default:
      io.stderr(`Unknown auth subcommand: ${subcommand || '(none)'}`);
      io.stderr('Available subcommands: login, export, import, status, rewrap');
      io.stderr('  agentbootup auth login [--server-url <url>] [--no-browser]');
      io.stderr('  agentbootup auth login --api-key <key> [--server-url <url>]');
      io.stderr('  agentbootup auth export --for-host <hostname> [--json]');
      io.stderr('  agentbootup auth import [--payload-file <path>]');
      io.stderr('  agentbootup auth status');
      io.stderr('  agentbootup auth rewrap --from-hostname <old-hostname>');
      process.exitCode = 1;
  }
}

/**
 * Recover a legacy hostname-bound credentials file whose hostname has drifted beyond
 * what the automatic candidates can guess, and re-encrypt it bound to this machine.
 *
 * The legacy format derived its key from os.hostname(), which macOS rewrites when the
 * network domain or the mDNS collision counter changes. Reading requires the exact
 * previous value, which only the operator can supply.
 */
export async function handleAuthRewrap(argv, io) {
  const fromHostname = getFlagValue(argv, '--from-hostname');
  if (!fromHostname || !fromHostname.trim()) {
    io.stderr('Usage: agentbootup auth rewrap --from-hostname <old-hostname>');
    io.stderr('  The hostname the credentials file was encrypted under.');
    process.exitCode = 1;
    return;
  }

  const targetFile = process.env.AGENTBOOTUP_CREDS_FILE ?? CREDS_FILE;
  let raw;
  try {
    raw = await fs.readFile(targetFile);
  } catch {
    io.stderr(`No credentials file at ${targetFile}. Run: agentbootup auth login --api-key <key>`);
    process.exitCode = 1;
    return;
  }

  const plaintext = decryptLegacyWithHostname(raw, fromHostname.trim());
  if (plaintext === null) {
    io.stderr(
      `Could not decrypt ${targetFile} using hostname "${fromHostname.trim()}". ` +
        'Either the hostname is wrong, or the file is already bound to this machine ' +
        '(only the legacy hostname format can be rewrapped). Run: agentbootup auth status'
    );
    process.exitCode = 1;
    return;
  }

  const creds = parseCredentialsPlaintextForRewrap(plaintext);
  if (!creds) {
    io.stderr(`Decrypted ${targetFile}, but its contents are not valid credentials.`);
    process.exitCode = 1;
    return;
  }

  try {
    await writeCredentials(creds);
  } catch (err) {
    // writeCredentials refuses to mint an identity over a corrupt machine-id file.
    // Surface that as a clean CLI error rather than an unhandled rejection.
    io.stderr(`Could not save rewrapped credentials: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  io.stdout(`Rewrapped ${targetFile}: now bound to this machine's stable identity.`);
  io.stdout('Hostname changes will no longer invalidate it.');
}
