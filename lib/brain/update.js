// `agentbootup brain update` — update mutable fields on an already-registered
// brain (PATCH /v1/brains/:id). Primary use: attach or change a repo URL after a
// repo-less registration, so a brain identity never has to wait on a git remote.

import {
  inspectCredentials,
  CREDS_STATE_OK,
  formatCredentialsRecoveryMessage,
} from '../auth/credentials.js';
import { apiUrl } from '../auth/validate.js';

const VALUE_FLAGS = new Set(['--repo', '--repo-branch', '--vault-namespace']);

function parseUpdateArgs(argv) {
  const args = [...argv];
  let brainId = null;
  let dryRun = false;
  const fields = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (VALUE_FLAGS.has(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('-')) {
        throw new Error(`${arg} requires a value`);
      }
      const val = args[++i];
      if (arg === '--repo') fields.repo_url = val;
      else if (arg === '--repo-branch') fields.repo_branch = val;
      else if (arg === '--vault-namespace') fields.vault_namespace = val;
    } else if (!arg.startsWith('-') && brainId === null) {
      brainId = arg;
    } else if (!arg.startsWith('-')) {
      throw new Error(`unexpected argument: ${arg}`);
    } else {
      throw new Error(`unknown flag: ${arg}`);
    }
  }

  return { brainId, fields, dryRun };
}

export async function runBrainUpdate(
  argv = [],
  io = { stdout: console.log, stderr: console.error },
  deps = {},
) {
  const {
    inspectCredentials: inspectCreds = inspectCredentials,
    fetch: fetchFn = fetch,
  } = deps;

  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout('Usage: agentbootup brain update <brain-id> [options]');
    io.stdout('');
    io.stdout('Update mutable fields on a registered brain (PATCH /v1/brains/:id).');
    io.stdout('');
    io.stdout('Options:');
    io.stdout('  --repo <url>           Attach or change the git repo URL');
    io.stdout('  --repo-branch <b>      Set the repo branch');
    io.stdout('  --vault-namespace <ns> Change the vault namespace');
    io.stdout('  --dry-run              Print payload without making request');
    return 0;
  }

  let parsed;
  try {
    parsed = parseUpdateArgs(argv);
  } catch (err) {
    io.stderr(`brain update: ${err.message}`);
    return 1;
  }
  const { brainId, fields, dryRun } = parsed;

  if (!brainId) {
    io.stderr('brain update: missing <brain-id>. Usage: agentbootup brain update <brain-id> [--repo <url>]');
    return 1;
  }

  if (Object.keys(fields).length === 0) {
    io.stderr('brain update: nothing to update — provide at least one of --repo, --repo-branch, --vault-namespace');
    return 1;
  }

  if (dryRun) {
    io.stdout(JSON.stringify(fields, null, 2));
    return 0;
  }

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
  const url = apiUrl(serverUrl, `/v1/brains/${encodeURIComponent(brainId)}`);

  let res;
  try {
    res = await fetchFn(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(fields),
    });
  } catch (err) {
    io.stderr(`brain update: network error: ${err.message}`);
    return 1;
  }

  let body;
  try {
    body = await res.json();
  } catch {
    body = {};
  }

  if (res.status === 404 || body?.error?.code === 'not_found') {
    io.stderr(`brain update: brain '${brainId}' is not registered. Register it first with: agentbootup brain register ${brainId}`);
    return 1;
  }

  if (res.status === 200 || res.status === 201) {
    io.stdout(`Updated: ${brainId}`);
    return 0;
  }

  const message = body?.error?.message ?? body?.message ?? `HTTP ${res.status}`;
  io.stderr(`brain update: ${message}`);
  return 1;
}
