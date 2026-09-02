// `agentbootup brain register` — register a brain on the agentbootup server.
// Wraps POST /v1/brains so the full provisioning flow (register → push → pull)
// is completeable without leaving the terminal or constructing raw curl calls.

import path from 'path';
import {
  inspectCredentials,
  CREDS_STATE_OK,
  formatCredentialsRecoveryMessage,
} from '../auth/credentials.js';
import { apiUrl } from '../auth/validate.js';
import { loadProjectConfig } from '../project-config.js';

const VALUE_FLAGS = new Set(['--repo', '--type', '--vault-namespace', '--cwd', '--path']);

function parseRegisterArgs(argv) {
  const args = [...argv];
  let brainId = null;
  let repo = null;
  let type = 'project_gm';
  let vaultNamespace = null;
  let cwd = process.cwd();
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (VALUE_FLAGS.has(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('-')) {
        throw new Error(`${arg} requires a value`);
      }
      const val = args[++i];
      if (arg === '--repo') repo = val;
      else if (arg === '--type') type = val;
      else if (arg === '--vault-namespace') vaultNamespace = val;
      else if (arg === '--cwd' || arg === '--path') cwd = val;
    } else if (!arg.startsWith('-') && brainId === null) {
      brainId = arg;
    } else if (!arg.startsWith('-')) {
      throw new Error(`unexpected argument: ${arg}`);
    } else {
      throw new Error(`unknown flag: ${arg}`);
    }
  }

  return { brainId, repo, type, vaultNamespace, cwd, dryRun };
}

export async function runBrainRegister(
  argv = [],
  io = { stdout: console.log, stderr: console.error },
  deps = {},
) {
  const {
    inspectCredentials: inspectCreds = inspectCredentials,
    fetch: fetchFn = fetch,
  } = deps;

  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout('Usage: agentbootup brain register <brain-id> [options]');
    io.stdout('');
    io.stdout('Register a brain on the agentbootup server (wraps POST /v1/brains).');
    io.stdout('');
    io.stdout('Options:');
    io.stdout('  --repo <url>           Git repo URL for this brain (optional; attach later with `brain update`)');
    io.stdout('  --type <type>          Brain type (default: project_gm)');
    io.stdout('  --vault-namespace <ns> Vault namespace (default: <brain-id>)');
    io.stdout('  --path <dir>           Project directory (alias: --cwd)');
    io.stdout('  --dry-run              Print payload without making request');
    return 0;
  }

  let parsed;
  try {
    parsed = parseRegisterArgs(argv);
  } catch (err) {
    io.stderr(`brain register: ${err.message}`);
    return 1;
  }
  const { brainId, repo: repoCli, type, vaultNamespace: vaultNamespaceCli, cwd, dryRun } = parsed;

  // Resolve early for consistent path handling throughout (loadProjectConfig resolves internally too).
  const resolvedCwd = path.resolve(cwd); // nosemgrep: path-join-resolve-traversal -- --cwd/--path is an explicit local working directory chosen by the operator

  if (!brainId) {
    io.stderr('brain register: missing <brain-id>. Usage: agentbootup brain register <brain-id> [--repo <url>]');
    return 1;
  }

  // Resolve --repo: CLI flag wins; fall back to agentbootup.json.
  let repo = repoCli;
  if (!repo) {
    try {
      const { config } = loadProjectConfig(resolvedCwd);
      if (config.repo_url) repo = config.repo_url;
    } catch (err) {
      // Re-surface parse/permission errors; silently ignore missing-file errors.
      if (!err?.message?.includes('No agentbootup.json found')) {
        io.stderr(`brain register: ${err?.message ?? err}`);
        return 1;
      }
    }
  }
  // repo is optional: a brain can be provisioned before any repo exists, and a
  // repo can be attached later with `agentbootup brain update <id> --repo <url>`.

  const vaultNamespace = vaultNamespaceCli ?? brainId;

  const payload = {
    id: brainId,
    type,
    vault_namespace: vaultNamespace,
    // Only include repo_url when one was resolved; omitting it registers a repo-less brain.
    ...(repo ? { repo_url: repo } : {}),
  };

  if (dryRun) {
    io.stdout(JSON.stringify(payload, null, 2));
    return 0;
  }

  // Authenticate.
  const credentialState = await inspectCreds();
  if (credentialState.state !== CREDS_STATE_OK) {
    io.stderr(
      formatCredentialsRecoveryMessage(credentialState, {
        missingMessage: 'No credentials. Run: agentbootup auth login --api-key <key>',
      }),
    );
    return 1;
  }

  const { apiKey, serverUrl } = credentialState.creds;
  const url = apiUrl(serverUrl, '/v1/brains');

  let res;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    io.stderr(`brain register: network error: ${err.message}`);
    return 1;
  }

  let body;
  try {
    body = await res.json();
  } catch {
    body = {};
  }

  // 409 or 400 + already_registered = idempotent, exit 0.
  if (res.status === 409 || ((res.status === 400) && body?.error?.code === 'already_registered')) {
    io.stdout(`${brainId} is already registered on the server.`);
    return 0;
  }

  if (res.status === 200 || res.status === 201) {
    io.stdout(`Registered: ${brainId}`);
    io.stdout(`Next: agentbootup brain push --path ${resolvedCwd}`);
    return 0;
  }

  // Any other 4xx/5xx.
  const message = body?.error?.message ?? body?.message ?? `HTTP ${res.status}`;
  io.stderr(`brain register: ${message}`);
  return 1;
}
