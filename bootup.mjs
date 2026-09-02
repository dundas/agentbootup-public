#!/usr/bin/env node
// agentbootup CLI entrypoint for operational brain lifecycle commands.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isNetworkCommand, runNetworkCommand } from './lib/network/cli-router.js';
import { runAuthCommand } from './lib/auth/auth.js';
import { runConfigCommand } from './lib/config/config-cli.js';
import { handleDoctor } from './lib/doctor/doctor.js';
import { getNetworkRoot } from './lib/config/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function printHelpAndExit(code = 0) {
  console.log(`\nagentbootup - Brain asset transport and runtime lifecycle CLI\n\n` +
`Version:\n` +
`  --version          Print the installed agentbootup version\n\n` +
`Auth Commands:\n` +
`  auth login [--server-url <url>] [--no-browser]\n` +
`                     Interactive ClearAuth browser login (device-auth flow)\n` +
`  auth login --api-key <key> [--server-url <url>]\n` +
`                     Save API credentials manually to ~/.agentbootup/credentials\n` +
`  auth export --for-host <hostname> [--json]\n` +
`                     Emit a host-bound credential handoff payload for trusted transport\n` +
`  auth import [--payload-file <path>]\n` +
`                     Import a host-bound credential handoff payload from stdin or file on the target host\n` +
`  auth status        Show current credential configuration\n\n` +
`Config Commands:\n` +
`  config set-brain <id>  Set the brain ID used by the transcript sync daemon\n` +
`  config set-converge <on|off>  Persist the default memory convergence policy\n` +
`  config set-network-root <path>\n` +
`                     Set the network root for multi-brain daemon sync\n` +
`  config list-brains     List all brains registered under your API key\n` +
`  config show            Show current configuration\n\n` +
`App Access Commands:\n` +
`  app access grant <app> --project <id> [--cwd <path>]\n` +
`  app access revoke <app> --project <id> [--cwd <path>]\n` +
`  app access list [<app>] [--json] [--cwd <path>]\n` +
`  machine-id [--json]    Print the stable local machine UUID\n\n` +
`  machine add --dry-run --source-root <dir> --target <name> [--remote <endpoint>] [--json]\n` +
`                     Report a non-mutating second-machine onboarding proposal; no secrets or daemon start\n\n` +
`Daemon Commands:\n` +
`  daemon start [project...|--all] [--no-transcripts] [--no-brain] [--no-brain-db] [--no-index-transcripts] [--no-inbox] [--no-narrative] [--skills-mode=static|mech-storage] [--yes]\n` +
`                         Start daemons (specific projects or --all)\n` +
`    --no-brain-db        Skip brain-db-sync daemons (local brain.db only, no remote sync)\n` +
`    --no-index-transcripts  Skip local transcript indexing on startup\n` +
`    --no-inbox           Skip inbox daemons\n` +
`    --no-narrative       Skip daily narrative generation for provisioned network projects\n` +
`    --skills-mode        Persist static or mech-storage skill projection mode\n` +
`  daemon stop [project...|--all] [--no-transcripts] [--no-brain] [--no-brain-db]\n` +
`                         Stop daemons (specific projects or --all)\n` +
`  daemon status [--json] Show status of all daemons\n` +
`  daemon verify [transcripts|brain] [--json]\n` +
`                         Confirm sync data is present in the cloud\n` +
`  daemon logs [transcripts|brain|brain-db] [--lines N]\n` +
`                         Print daemon logs (default: both)\n\n` +
`Host-extension Commands:\n` +
`  host-extension dry-run [--json]  Run the local generic relay contract fixture\n` +
`  host-extension serve --module <local-module> [--jsonl]\n` +
`                         Start the managed daemon with a generic local extension installer\n\n` +
`Transcript Archive Commands:\n` +
`  transcripts backup [--all | --cwd <project>] [--cli <provider>] [--since <date>] [--dry-run] [--yes] [--json]\n` +
`  transcripts status [--all | --cwd <project>] [--cli <provider>] [--since <date>] [--json]\n` +
`  transcripts verify [--all | --cwd <project>] [--cli <provider>] [--since <date>] [--deep] [--json]\n` +
`  transcripts restore [--session <id> | --since <date> [--before <date>] | --archive-version <id> | --source-machine <id> | --all]\n` +
`                      [--cli <provider>] [--brain <id> | --cwd <project>] [--native | --output-dir <path>] [--json]\n` +
`  transcripts offload [--older-than <duration> | --before <date> | --session <id>] [--cwd <project>] [--cli <provider>]\n` +
`                      [--dry-run] [--apply [--yes]] [--json]\n` +
`                      Duration units: m=minutes, h=hours, d=days, w=weeks.\n` +
`                         Offload apply is disabled while production evidence is PAUSE; dry-run never deletes files\n` +
`  transcripts mitigate-remote-copy --redact [--repush] [--yes] [--cli <provider>] [--cwd <project>]\n` +
`                      [--since <ISO timestamp>] [--since-basis <mtime|session|key>]\n` +
`                         Writes protected local snapshots by default; --repush overwrites only exact reviewed remote keys\n` +
`                         Back up and verify independently of daemon state; local files are retained\n\n` +
    `Bundle Commands:\n` +
    `  bundle publish --manifest <path> [--source-root <dir>] [--dry-run] [--json]\n` +
    `  bundle report --manifest <path> [--source-root <dir>] [--target-root <dir>] [--roots-config <path>] [--json]\n` +
    `  bundle status --manifest <path> [--source-root <dir>] [--target-root <dir>] [--json]\n` +
    `  bundle rehash --manifest <path> [--source-root <dir>] [--dry-run] [--json]\n` +
    `  bundle install --manifest <path> [--source-root <dir>] [--target-root <dir>] [--force] [--dry-run] [--skip-validation|--no-validate] [--materialize-agents] [--json]\n` +
    `  bundle rollback --manifest <path> [--target-root <dir>] [--dry-run] [--json]\n` +
    `  bundle sync <selector> [--target-root <dir>] [--cli <csv>] [--force] [--dry-run] [--no-reindex] [--materialize-agents] [--json]\n` +
    `  bundle rollout <selector> [--source-root <dir>] [--all | --env <name> | --project <id[,id]> | --brain <id[,id]>] [--dry-run] [--skip-validation|--no-validate] [--materialize-agents] [--json]\n` +
    `                     Bundle commands support a canonical --json envelope and mapped exit codes.\n\n` +
    `Memory Commands:\n` +
    `  memory capture  [--cwd <dir>]\n` +
    `  memory refresh  [--cwd <dir>] [--force] [--from-store] [--latest] [--store <url>]\n` +
    `  memory publish  [--snapshot-id <id>] [--cwd <dir>] [--store <url>]\n` +
    `  memory flush    [--snapshot-id <id>] [--cwd <dir>] [--store <url>] [--json]\n` +
    `  memory replay   [--cwd <dir>] [--store <url>] [--json]\n` +
    `                  [--inspect <queue-id>] | [--discard <queue-id> --confirm-loss]\n` +
    `  memory diagnose [--cwd <dir>] [--store <url>] [--json]  read-only queue and remote-store health\n` +
    `  memory snapshot [--snapshot-id <id>] [--cwd <dir>] [--dry-run]\n` +
    `  memory restore --snapshot <manifest-path> [--target <dir>] [--force] [--dry-run]\n\n` +
    `Brain Commands:\n` +
    `  brain register <brain-id> [--repo <url>] [--type <type>] [--vault-namespace <ns>] [--path <dir>] [--dry-run]\n` +
    `                         Register a brain on the server (wraps POST /v1/brains; --repo optional)\n` +
    `  brain update <brain-id> [--repo <url>] [--repo-branch <b>] [--vault-namespace <ns>] [--dry-run]\n` +
    `                         Update a registered brain, e.g. attach a repo later (wraps PATCH /v1/brains/:id)\n` +
    `  brain link <agent-id> [--path <dir>]\n` +
    `                         Link a brain to a local directory\n` +
    `  brain unlink <agent-id>\n` +
    `                         Remove local path but keep brain in registry\n` +
    `  brain remove <agent-id>\n` +
    `                         Remove brain entirely from network config\n` +
    `  brain list             List all brains with link status\n` +
    `  brain branch create <brain-id> --tenant <ref> [--branch <id>]\n` +
    `  brain branch list <brain-id> [--json]\n` +
    `  brain branch delete <brain-id> --branch <id> [--json]\n` +
    `  brain pull [<brain-id>] [--path <dir>] [--force] [--dry-run] [--verbose]\n` +
    `                         Pull brain asset files using strict local project identity by default\n` +
    `    --rotate-identity --yes  Replace the local Ed25519 identity and re-register\n` +
    `    --no-daemon         Skip daemon startup after a successful pull\n` +
    `  brain restore [<brain-id>] [--branch <id>] [--target <dir>|--to <dir>]\n` +
    `                         Restore branch-aware brain assets from server to this project\n` +
    `    --target <dir>       Where to write files (default: CWD)\n` +
    `    --to <dir>           Alias for --target\n` +
    `    --branch <id>        Branch id to restore (default: default)\n` +
    `    --subset <csv>       memory,skills,agents,commands,protocols,config\n` +
    `    --force              Overwrite existing local files\n` +
    `    --dry-run            Preview without writing\n` +
    `    --verbose            Print each file action\n` +
    `  brain index-transcripts\n` +
    `                         Index AI CLI transcripts into local brain.db for FTS5 search\n` +
    `    --target <dir>       Project dir containing .brain/brain.db (default: CWD)\n` +
    `    --dry-run            Report chunks without writing\n` +
    `    --verbose            Print per-file progress\n` +
    `    --sync-transcripts   Mark chunks syncable=1 and trigger an immediate remote sync\n` +
    `                         via SIGUSR1 to the brain-db-sync daemon. Requires the daemon\n` +
    `                         to be running: agentbootup daemon start --yes\n` +
    `    --max-sessions <n>   Limit sessions processed\n` +
    `    --max-age <days>     Skip transcripts older than N days\n\n` +
    `Secrets (manual sync only):\n` +
    `  secrets push [--dry-run] [--cwd <path>] [--ttl <duration>]\n` +
    `                         Push .env and brain/config.secret.json to server\n` +
    `  secrets pull [--force] [--dry-run] [--cwd <path>]\n` +
    `                         Pull secrets from server into this project\n\n` +
`Diagnostics:\n` +
    `  doctor [--json]    Run local health audit and report issues\n` +
    `  doctor --health [--json]  Run the four active checks, emit the health record (exit non-zero if not healthy)\n` +
`  brain doctor --branch-mode --brain <id> --branch <id> [--json]\n` +
`                     Validate branch overlay runtime contract and registry drift\n\n` +
`Burn-in Commands:\n` +
`  burn-in preflight  Validate configured local and remote standalone burn-in runtimes\n` +
`  burn-in service <install|start|stop|restart|status>\n` +
`                     Manage the explicitly configured per-brain burn-in service\n\n` +
    `Share Sync:\n` +
    `  share configure --provider <smb|nfs|local> --path <path> [--remote <remote>] [--mount-point <path>]\n` +
    `  share mount        Mount the configured shared folder\n` +
    `  share unmount      Unmount the configured shared folder\n` +
    `  share status       Show current share configuration and reachability\n` +
    `  share push [project-id] [--cwd <path>] [--dry-run]\n` +
    `                     Copy local brain assets + transcripts into the mounted share\n` +
    `  share pull [project-id] [--cwd <path>] [--dry-run]\n` +
    `                     Copy the latest shared brain assets + transcripts into the local machine\n\n` +
    `Brain mount (portfolio lifecycle):\n` +
    `  publish-code [<brain>] [--cwd <dir>] [--dry-run] [--force-dirty]\n` +
    `                     Git-archive HEAD → gzip → push to brain-assets (script bundle)\n` +
    `  status <brain>     Show install state, daemon health, last sync, manifest version\n` +
    `  update <project-id> (--env-config <path> | --env <name>) [--cwd <dir>] [--bypass-approvals]\n` +
    `                     Revalidate existing install state and reapply env contract without reprovision\n` +
    `  unmount <project-id> (--env <name> | --env-config <path>) [--cwd <dir>]\n` +
    `                     Remove mount state only; preserve project linkage and brain identity\n` +
    `  bootup-machine <project-id> --repo <git-url> --env-config <path> [--api-key <key>] [--network-root <path>] [--server-url <url>]\n` +
    `  bootup-machine --plan <manifest-path> [--api-key <key>] [--server-url <url>]\n` +
    `                     Deterministic local machine bootstrap: auth, clone, add, trust, restore, install, daemon start\n` +
    `  bootup-machine plan create|run|validate|show ...\n` +
    `                     Shared bootstrap manifest for push / pull / script execution modes\n` +
    `  uninstall <brain> [--dry-run] [--yes] [--purge] [--skip-push]\n` +
    `                     brain push → stop daemons → remove from network config\n` +
    `  compile-card <project-id> [--env <name>] [--cwd <dir>] [--dry-run]\n` +
    `                     Write .brain/agent-card.json (PRD-0019)\n` +
    `  list-cards --env <name> [--cwd <dir>]\n` +
    `                     JSON list of agent cards for an environment\n` +
    `  mount <project-id> --env-config <path> [--cwd <dir>] [--bypass-approvals]\n` +
    `                     Legacy alias: idempotent env mount (Phase 3 — ~/.brain/mounts/...)\n` +
    `  list-mounts [<project-id>] [--cwd <dir>]\n` +
    `                     Legacy alias: JSON list of active environment mounts (--cwd ignored for paths; uses AGENTBOOTUP_MOUNTS_BASE or ~/.brain/mounts)\n\n` +
`Notes:\n` +
`  seed/local scaffolding has been removed.\n` +
`  Use brain restore, brain push/pull, share push/pull, and daemon sync flows instead.\n`);
  process.exit(code);
}

function normalizeTopLevelArgv(argv) {
  const leadingGlobals = [];
  let index = 0;
  while (index < argv.length) {
    if (argv[index] === '--cwd' && argv[index + 1]) {
      leadingGlobals.push(argv[index], argv[index + 1]);
      index += 2;
      continue;
    }
    break;
  }

  const commandToken = index < argv.length ? argv[index] : null;
  if (commandToken == null) {
    return { commandToken: null, normalizedArgv: leadingGlobals, commandArgv: [] };
  }

  return {
    commandToken,
    normalizedArgv: [commandToken, ...leadingGlobals, ...argv.slice(index + 1)],
    commandArgv: argv.slice(index),
  };
}

async function run() {
  const rawArgv = process.argv.slice(2);
  const { commandToken, normalizedArgv, commandArgv } = normalizeTopLevelArgv(rawArgv);

  if (rawArgv.includes('--version')) {
    console.log(readPackageVersion());
    return;
  }

  if (commandToken === '--help' || commandToken === '-h') {
    printHelpAndExit(0);
  }

  // Auth commands are global (no project config required)
  if (rawArgv[0] === 'auth') {
    await runAuthCommand(rawArgv);
    return;
  }

  // Global config commands (brain ID, etc.)
  if (rawArgv[0] === 'config') {
    await runConfigCommand(rawArgv);
    return;
  }

  if (rawArgv[0] === 'burn-in') {
    const sub = rawArgv[1];
    if (sub === 'service' && rawArgv.length === 3) {
      const action = rawArgv[2];
      try {
        const service = await import('./lib/burn-in/service-manager.js');
        if (action === 'install' || action === 'start') {
          const result = await service.installBurnInService();
          console.log(JSON.stringify({ burn_in_service: { state: 'started', name: result.name } }));
        } else if (action === 'stop') {
          await service.stopBurnInService();
          console.log(JSON.stringify({ burn_in_service: { state: 'stopped' } }));
        } else if (action === 'restart') {
          const result = await service.restartBurnInService();
          console.log(JSON.stringify({ burn_in_service: { state: 'restarted', name: result.name } }));
        } else if (action === 'status') {
          console.log(JSON.stringify({ burn_in_service: await service.burnInServiceStatus() }));
        } else {
          throw new Error('invalid service action');
        }
      } catch (err) {
        console.error(`burn-in service: ${err instanceof Error ? err.message : 'failed'}`);
        process.exitCode = 1;
      }
      return;
    }
    if (sub === 'preflight' && rawArgv.length === 2) {
      const { loadBurnInConfig } = await import('./scripts/burn-in/runtime.mjs');
      const { preflightBurnIn } = await import('./scripts/burn-in/preflight.mjs');
      const config = loadBurnInConfig();
      const result = await preflightBurnIn(config);
      if (!result.ready) { console.error(JSON.stringify({ burn_in_preflight: { state: 'not_ready', code: result.code } })); process.exitCode = 1; }
      else console.log(JSON.stringify({ burn_in_preflight: { state: 'ready', brain: config.brain, store: config.store } }));
      return;
    }
    if (sub === 'remote') {
      try {
        const { runRemoteHelper } = await import('./scripts/burn-in/remote-helper.mjs');
        const result = runRemoteHelper(rawArgv.slice(2), await new Response(process.stdin).text());
        console.log(JSON.stringify(result));
        if (result?.ready === false || result?.ok === false) process.exitCode = 1;
      } catch { console.error('burn-in remote: invalid arguments'); process.exitCode = 2; }
      return;
    }
    if (sub === 'attest') {
      const values = Object.create(null);
      for (let i = 2; i < rawArgv.length; i += 2) {
        if (!['--root', '--brain', '--ref', '--commit'].includes(rawArgv[i]) || !rawArgv[i + 1] || Object.hasOwn(values, rawArgv[i])) { console.error('burn-in attest: invalid arguments'); process.exitCode = 2; return; }
        values[rawArgv[i]] = rawArgv[i + 1];
      }
      if (Object.keys(values).length !== 4) { console.error('burn-in attest: invalid arguments'); process.exitCode = 2; return; }
      const { attestRuntime } = await import('./scripts/burn-in/runtime.mjs');
      const result = attestRuntime(values['--root'], { brain: values['--brain'], canonicalRef: values['--ref'], canonicalCommit: values['--commit'] });
      console.log(JSON.stringify(result));
      if (!result.ready) process.exitCode = 1;
      return;
    }
    console.error('Usage: agentbootup burn-in preflight | service <install|start|stop|restart|status> | attest --root <dir> --brain <id> --ref <canonical-ref> --commit <immutable-commit>');
    process.exitCode = 2;
    return;
  }

  // Migration shims — old daemon commands removed in v0.8.3.
  if (commandToken === 'sync-daemon' || commandToken === 'brain-daemon') {
    const isBrain = commandToken === 'brain-daemon';
    const sub = commandArgv[1];
    // Transcript recovery moved under the transcript archive command family.
    if (sub === 'pull' || sub === 'restore') {
      console.error(
        `\`agentbootup ${commandToken} ${sub}\` has been removed.\n\n` +
        `Use instead:\n  agentbootup transcripts restore\n`
      );
    } else {
      console.error(
        `\`agentbootup ${commandToken}\` has been removed.\n\n` +
        `Use the unified daemon command instead:\n` +
        `  agentbootup daemon start [project...|--all] [--yes]\n` +
        `  agentbootup daemon stop [project...|--all]\n` +
        `  agentbootup daemon status [--json]\n` +
        `  agentbootup daemon logs [transcripts|brain] [--lines N]\n` +
        (isBrain ? `\nNote: brain pull/restore are under \`agentbootup brain pull/restore\`\n` : '')
      );
    }
    process.exit(1);
  }

  // Unified daemon command (transcript sync + brain asset sync)
  if (rawArgv[0] === 'daemon') {
    const { runDaemonCommand } = await import('./lib/daemon/unified-daemon-cli.js');
    await runDaemonCommand(rawArgv);
    return;
  }

  if (commandToken === 'host-extension') {
    const hostCwd = rawArgv[0] === '--cwd' && typeof rawArgv[1] === 'string' && rawArgv[1].length > 0
      ? path.resolve(rawArgv[1]) : null;
    if (hostCwd) process.chdir(hostCwd);
    // The sealed Plane connector is Bun-only. Keep the ordinary fixture usable
    // on Node, but run the operational daemon in the runtime its dependency
    // exports target rather than failing later during a dynamic import.
    if (commandArgv[1] === 'serve' && !process.versions.bun) {
      const { spawn } = await import('node:child_process');
      const jsonl = rawArgv.includes('--jsonl');
      const forwardedArgv = hostCwd ? ['--cwd', hostCwd, ...rawArgv.slice(2)] : rawArgv;
      const child = spawn(process.env.AGENTBOOTUP_BUN_BINARY || 'bun', [process.argv[1], ...forwardedArgv], { stdio: 'inherit' });
      const exitCode = await new Promise((resolve) => {
        child.once('error', (error) => {
          const message = `host-extension serve requires Bun because its local Mech Plane runtime is Bun-only: ${error.message}`;
          if (jsonl) console.log(JSON.stringify({ version: 1, sequence: 0, timestamp: new Date().toISOString(), event: 'error', data: { message, code: 'runtime', exitCode: 1, retryable: false } }));
          else console.error(message);
          resolve(1);
        });
        child.once('exit', (code, signal) => resolve(Number.isInteger(code) ? code : signal ? 1 : 0));
      });
      if (exitCode) process.exitCode = exitCode;
      return;
    }
    const io = { stdout: (line) => console.log(line), stderr: (line) => console.error(line) };
    const { runHostExtensionClientCli } = await import('./lib/daemon/host-extension-client-cli.mjs');
    const exitCode = await runHostExtensionClientCli(commandArgv.slice(1), io);
    if (exitCode) process.exitCode = exitCode;
    return;
  }

  if (commandToken === 'bundle') {
    const io = { stdout: (l) => console.log(l), stderr: (l) => console.error(l) };
    const { runBundleCommand } = await import('./lib/bundle/cli.js');
    const exitCode = await runBundleCommand(normalizedArgv.slice(1), io);
    if (exitCode) process.exitCode = exitCode;
    return;
  }

  if (commandToken === 'memory') {
    const io = { stdout: (l) => console.log(l), stderr: (l) => console.error(l) };
    const { runMemoryCommand } = await import('./lib/memory/cli.js');
    const exitCode = await runMemoryCommand(normalizedArgv.slice(1), io);
    if (exitCode) process.exitCode = exitCode;
    return;
  }

  if (commandToken === 'transcripts') {
    const io = { stdout: (l) => console.log(l), stderr: (l) => console.error(l) };
    const { runTranscriptsCommand } = await import('./lib/transcript-archive/cli.js');
    const exitCode = await runTranscriptsCommand(normalizedArgv.slice(1), io);
    if (exitCode) process.exitCode = exitCode;
    return;
  }

  // Health audit
  if (commandToken === 'doctor') {
    await handleDoctor(normalizedArgv.slice(1));
    return;
  }

  if (rawArgv[0] === 'share') {
    const io = { stdout: (l) => console.log(l), stderr: (l) => console.error(l) };
    const { runShareCommand } = await import('./lib/share/cli.js');
    const exitCode = await runShareCommand(rawArgv.slice(1), io);
    if (exitCode) process.exitCode = exitCode;
    return;
  }

  // brain-mount Phase 1b — lifecycle (auth + network; routed before seed/network split)
  if (rawArgv[0] === 'publish-code') {
    const io = { stdout: (l) => console.log(l), stderr: (l) => console.error(l) };
    const { runPublishCode } = await import('./lib/brain/publish-code.js');
    const exitCode = await runPublishCode(rawArgv.slice(1), io);
    if (exitCode) process.exitCode = exitCode;
    return;
  }
  if (rawArgv[0] === 'uninstall') {
    const io = { stdout: (l) => console.log(l), stderr: (l) => console.error(l) };
    const { runUninstallBrain } = await import('./lib/brain/uninstall-brain.js');
    const exitCode = await runUninstallBrain(rawArgv.slice(1), io);
    if (exitCode) process.exitCode = exitCode;
    return;
  }
  if (rawArgv[0] === 'bootup-machine') {
    const io = { stdout: (l) => console.log(l), stderr: (l) => console.error(l) };
    const { runBootupMachineCommand } = await import('./lib/network/commands/bootup-machine.js');
    const exitCode = await runBootupMachineCommand(rawArgv.slice(1), io);
    if (exitCode) process.exitCode = exitCode;
    return;
  }
  if (commandToken === 'machine') {
    const io = { stdout: (l) => console.log(l), stderr: (l) => console.error(l) };
    const { runMachineCommand } = await import('./lib/network/commands/machine-add.js');
    const exitCode = await runMachineCommand(normalizedArgv.slice(1), io);
    if (exitCode) process.exitCode = exitCode;
    return;
  }
  if (rawArgv[0] === 'compile-card') {
    const io = { stdout: (l) => console.log(l), stderr: (l) => console.error(l) };
    const { runCompileCardCommand } = await import('./lib/brain/compile-agent-card.js');
    const exitCode = runCompileCardCommand(rawArgv.slice(1), io);
    if (exitCode) process.exitCode = exitCode;
    return;
  }
  if (rawArgv[0] === 'list-cards') {
    const io = { stdout: (l) => console.log(l), stderr: (l) => console.error(l) };
    const { runListCardsCommand } = await import('./lib/brain/compile-agent-card.js');
    const exitCode = runListCardsCommand(rawArgv.slice(1), io);
    if (exitCode) process.exitCode = exitCode;
    return;
  }
  // Portable lifecycle commands and legacy aliases.
  if (rawArgv[0] === 'mount') {
    const io = { stdout: (l) => console.log(l), stderr: (l) => console.error(l) };
    const { runMountCommand } = await import('./lib/network/commands/mount-cli.js');
    const exitCode = await runMountCommand(rawArgv.slice(1), io);
    if (exitCode) process.exitCode = exitCode;
    return;
  }
  if (rawArgv[0] === 'update') {
    const io = { stdout: (l) => console.log(l), stderr: (l) => console.error(l) };
    const { runUpdateCommand } = await import('./lib/network/commands/mount-cli.js');
    const exitCode = await runUpdateCommand(rawArgv.slice(1), io);
    if (exitCode) process.exitCode = exitCode;
    return;
  }
  if (rawArgv[0] === 'unmount') {
    const io = { stdout: (l) => console.log(l), stderr: (l) => console.error(l) };
    const { runUnmountCommand } = await import('./lib/network/commands/mount-cli.js');
    const exitCode = await runUnmountCommand(rawArgv.slice(1), io);
    if (exitCode) process.exitCode = exitCode;
    return;
  }
  if (rawArgv[0] === 'list-mounts') {
    const io = { stdout: (l) => console.log(l), stderr: (l) => console.error(l) };
    const { runListMountsCommand } = await import('./lib/network/commands/mount-cli.js');
    const exitCode = runListMountsCommand(rawArgv.slice(1), io);
    if (exitCode) process.exitCode = exitCode;
    return;
  }
  // Brain subcommands — these use brain/config.json + auth credentials,
  // not the network agentbootup.json, so they must be intercepted before
  // the network-config gate below.
  if (rawArgv[0] === 'brain') {
    const io = { stdout: (l) => console.log(l), stderr: (l) => console.error(l) };

    if (rawArgv[1] === 'pull') {
      // Note: `agentbootup brain pull` now performs brain asset file-fetch (FR-5/FR-6).
      // Transcript recovery is exposed by `agentbootup transcripts restore`.
      if (!rawArgv.includes('--help') && !rawArgv.includes('-h') && process.stderr.isTTY) {
        console.error('note: `agentbootup brain pull` syncs brain asset files. For transcript recovery use `agentbootup transcripts restore`.');
      }
      const { runBrainPull } = await import('./lib/brain/pull.js');
      const exitCode = await runBrainPull(rawArgv.slice(2), io);
      if (exitCode) process.exitCode = exitCode;
      return;
    }

    if (rawArgv[1] === 'rotate-keys') {
      const { runBrainRotateKeys } = await import('./lib/brain/rotate-keys.js');
      const exitCode = await runBrainRotateKeys(rawArgv.slice(2), io);
      if (exitCode) process.exitCode = exitCode;
      return;
    }

    if (rawArgv[1] === 'register') {
      const { runBrainRegister } = await import('./lib/brain/register.js');
      const exitCode = await runBrainRegister(rawArgv.slice(2), io);
      if (exitCode) process.exitCode = exitCode;
      return;
    }

    if (rawArgv[1] === 'update') {
      const { runBrainUpdate } = await import('./lib/brain/update.js');
      const exitCode = await runBrainUpdate(rawArgv.slice(2), io);
      if (exitCode) process.exitCode = exitCode;
      return;
    }

    if (rawArgv[1] === 'restore') {
      if (rawArgv.includes('--boot')) {
        const { runBrainRestoreBoot } = await import('./lib/brain/restore-boot.js');
        await runBrainRestoreBoot(rawArgv.slice(2));
        return;
      }
      const { runBrainRestore } = await import('./lib/brain/restore.js');
      await runBrainRestore(rawArgv.slice(2));
      return;
    }

    if (rawArgv[1] === 'link') {
      const { runBrainLink } = await import('./lib/brain/link.js');
      const exitCode = await runBrainLink(rawArgv.slice(2), io);
      if (exitCode) process.exitCode = exitCode;
      return;
    }

    if (rawArgv[1] === 'unlink') {
      const { runBrainUnlink } = await import('./lib/brain/link.js');
      const exitCode = await runBrainUnlink(rawArgv.slice(2), io);
      if (exitCode) process.exitCode = exitCode;
      return;
    }

    if (rawArgv[1] === 'remove') {
      const { runBrainRemove } = await import('./lib/brain/link.js');
      const exitCode = await runBrainRemove(rawArgv.slice(2), io);
      if (exitCode) process.exitCode = exitCode;
      return;
    }

    if (rawArgv[1] === 'list') {
      const { runBrainList } = await import('./lib/brain/link.js');
      const exitCode = await runBrainList(rawArgv.slice(2), io);
      if (exitCode) process.exitCode = exitCode;
      return;
    }

    if (rawArgv[1] === 'index-transcripts') {
      const { runIndexTranscripts } = await import('./lib/brain/index-transcripts.js');
      await runIndexTranscripts(rawArgv.slice(2));
      return;
    }

    // Network-owned brain subcommands, help, and bare "brain" route through runBrainCommand.
    const { runBrainCommand } = await import('./lib/network/commands/brain.js');
    const exitCode = await runBrainCommand(rawArgv.slice(1), io);
    if (exitCode) process.exitCode = exitCode;
    return;
  }

  // Manual secrets sync (project must have brain/config.json)
  if (rawArgv[0] === 'secrets') {
    const { extractCwd, hasFlag, getFlagValue } = await import('./lib/network/args.js');
    // Read sub directly from rawArgv[1] (consistent with brain subcommand routing).
    // extractCwd receives the flags/options slice — rawArgv.slice(2) strips 'secrets' and sub.
    const sub = rawArgv[1];
    const extracted = extractCwd(rawArgv.slice(2));
    const io = { stdout: (l) => console.log(l), stderr: (l) => console.error(l) };

    if (!sub || sub === '--help' || sub === '-h') {
      const { printUsage: printSecretsUsage } = await import('./lib/network/commands/secrets.js');
      printSecretsUsage(io);
      return;
    }
    if (sub !== 'push' && sub !== 'pull') {
      console.error(`Unknown secrets subcommand: "${sub}". Use push or pull.`);
      process.exitCode = 1;
      return;
    }

    const cwd = path.resolve(extracted.cwd);
    const dryRun = hasFlag(extracted.args, '--dry-run');
    const force = hasFlag(extracted.args, '--force');

    if (sub === 'push') {
      let ttlSeconds;
      const ttlRaw = getFlagValue(extracted.args, '--ttl');
      if (ttlRaw) {
        const { parseTtlToSeconds } = await import('./lib/network/commands/secrets.js');
        const parsed = parseTtlToSeconds(ttlRaw);
        if (!parsed.ok) {
          console.error(`secrets push: ${parsed.error}`);
          process.exitCode = 1;
          return;
        }
        ttlSeconds = parsed.seconds;
      }
      const { runSecretsPush } = await import('./lib/network/commands/secrets.js');
      const code = await runSecretsPush(cwd, io, { dryRun, ttlSeconds });
      if (code) process.exitCode = code;
      return;
    }
    if (sub === 'pull') {
      const { runSecretsPull } = await import('./lib/network/commands/secrets.js');
      const code = await runSecretsPull(cwd, io, { force, dryRun });
      if (code) process.exitCode = code;
      return;
    }
  }

  // Deprecated commands — the rsync-based sync system has been replaced by the
  // persistent daemon. Point users at the new commands instead of silently
  // running broken or obsolete behaviour.
  if (commandToken === 'restore-transcripts') {
    console.error(
      `\`agentbootup restore-transcripts\` is deprecated and no longer functional.\n` +
      `\n` +
      `To restore transcripts, use:\n` +
      `  agentbootup transcripts restore            # restore from the archive\n` +
      `\n` +
      `For continuous background sync:\n` +
      `  agentbootup daemon start [--yes]             # start background sync\n` +
      `  agentbootup daemon verify                    # confirm data is in the cloud\n`
    );
    process.exit(1);
  }
  if (commandToken === 'sync-transcripts') {
    console.error(
      `\`agentbootup sync-transcripts\` is deprecated and no longer functional.\n` +
      `\n` +
      `Use the daemon commands instead:\n` +
      `  agentbootup auth login                      # interactive ClearAuth browser login\n` +
      `  agentbootup auth login --api-key <key>      # manual credential setup\n` +
      `  agentbootup config set-brain <id>           # one-time brain ID setup\n` +
      `  agentbootup daemon start [--yes]             # start continuous background sync\n` +
      `  agentbootup daemon status                   # check process health\n` +
      `  agentbootup daemon verify                    # confirm data is in the cloud\n`
    );
    process.exit(1);
  }

  const explicitNetworkNamespace = commandToken === 'network';
  const networkCwd = resolveNetworkCommandCwd(rawArgv, process.cwd());
  let hasNetworkConfig = fs.existsSync(path.join(networkCwd, 'agentbootup.json'));
  const explicitNetworkArgv = explicitNetworkNamespace
    ? normalizeTopLevelArgv(normalizedArgv.slice(1)).normalizedArgv
    : [];

  // Commands that have internal network-root fallback logic can be routed
  // even when CWD has no config — they resolve the root themselves.
  const NETWORK_ROOT_AWARE = new Set(['add']);
  const commandName = explicitNetworkNamespace ? explicitNetworkArgv[0] : commandToken;
  if (!hasNetworkConfig && NETWORK_ROOT_AWARE.has(commandName)) {
    const networkRoot = await getNetworkRoot();
    if (networkRoot && fs.existsSync(path.join(networkRoot, 'agentbootup.json'))) {
      hasNetworkConfig = true;
    }
  }

  if (commandToken === 'status' && !hasNetworkConfig) {
    const io = { stdout: (l) => console.log(l), stderr: (l) => console.error(l) };
    const { runBrainStatus } = await import('./lib/brain/brain-status.js');
    const exitCode = await runBrainStatus(normalizedArgv.slice(1), io);
    if (exitCode) process.exitCode = exitCode;
    return;
  }

  if (explicitNetworkNamespace || (isNetworkCommand(commandToken) && hasNetworkConfig)) {
    const exitCode = await runNetworkCommand(explicitNetworkNamespace ? explicitNetworkArgv : normalizedArgv);
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
    return;
  }

  if (commandToken == null) {
    if (isNetworkRootConfig(networkCwd)) {
      const exitCode = await runNetworkCommand([]);
      if (exitCode !== 0) {
        process.exitCode = exitCode;
      }
      return;
    }
    printHelpAndExit(0);
  }

  if (commandToken === 'seed') {
    console.error(
      '`agentbootup seed` has been removed.\n\n' +
      'Use one of the supported materialization flows instead:\n' +
      '  agentbootup brain restore [<brain-id>] [--target <dir>]\n' +
      '  agentbootup brain push|pull [--cwd <path>]\n' +
      '  agentbootup share push|pull [project-id] [--cwd <path>]\n'
    );
    printHelpAndExit(1);
  }

  console.error(`❌ Unknown command "${commandToken}".`);
  printHelpAndExit(1);
}

function resolveNetworkCommandCwd(argv, defaultCwd) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cwd' && argv[i + 1]) {
      return path.resolve(argv[i + 1]); // nosemgrep: path-join-resolve-traversal -- --cwd selects the local repo context for CLI routing; command handlers validate downstream usage
    }
  }
  return defaultCwd;
}

function isNetworkRootConfig(cwd) {
  try {
    const configPath = path.join(cwd, 'agentbootup.json'); // nosemgrep: path-join-resolve-traversal -- cwd is the local CLI working directory already selected for command routing
    if (!fs.existsSync(configPath)) return false;
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return parsed?.role === 'network';
  } catch {
    return false;
  }
}

run().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
