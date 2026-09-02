import { runStatusCommand } from './commands/status.js';
import { runDoctorCommand } from './commands/doctor.js';
import { runSyncCommand } from './commands/sync.js';
import { runAddCommand } from './commands/add.js';
import { runProvisionCommand } from './commands/provision.js';
import { runTrustCommand } from './commands/trust.js';
import { runWatchCommand } from './commands/watch.js';
import { runPullCommand } from './commands/pull.js';
import { runEnvCommand } from './commands/env.js';
import { runRestoreCommand } from './commands/restore.js';
import { runSyncTranscriptsCommand } from './commands/sync-transcripts.js';
import { runRestoreTranscriptsCommand } from './commands/restore-transcripts.js';
import { runAnalyzeCommand } from './commands/analyze.js';
import { runBrainCommand } from './commands/brain.js';
import { runNetworkPushCommand } from './commands/network-push.js';
import { runSkillsCommand } from './commands/skills.js';
import { runBrainDbCommand } from './commands/brain-db.js';
import { runInstallCommand } from './commands/install.js';
import { runAppCommand } from './commands/app.js';
import { runMachineIdCommand } from './commands/machine-id.js';

const NETWORK_COMMANDS = new Set([
  'status',
  'doctor',
  'sync',
  'add',
  'install',
  'provision',
  'trust',
  'watch',
  'pull',
  'env',
  'restore',
  'sync-transcripts',
  'restore-transcripts',
  'analyze',
  'brain',
  'brain-db',
  'push',
  'network',
  'skills',
  'app',
  'machine-id',
]);

export function isNetworkCommand(command) {
  return NETWORK_COMMANDS.has(command);
}

function printHelp(io) {
  io.stdout('agentbootup network commands:');
  io.stdout('  status [<brain-id>] [--env <name>] [--cwd <path>]');
  io.stdout('           With <brain-id>: per-brain install path, daemons, package version');
  io.stdout('           Do not combine <brain-id> with --env (per-brain vs env filter)');
  io.stdout('  doctor [project-id] [--env <name>] [--fix] [--cwd <path>]');
  io.stdout('  sync [project-id] [--dry-run] [--commit] [--cwd <path>]');
  io.stdout('  add <id> <path> --agent <agent-id> [--type <type>] [--capabilities "a,b"] [--reports-to <agent>] [--untrusted] [--cwd <path>]');
  io.stdout('  install --env <name> [--dry-run] [--portfolio-protocols] [--cwd <path>]');
  io.stdout('  provision <project-id> [--env <name>] [--fly] [--portfolio-protocols] [--cwd <path>]');
  io.stdout('  provision --env <name>   # provision all projects in environment (ordered)');
  io.stdout('  provision --agent <id> --type <type> --repo <path> [--portfolio-protocols] [--cwd <path>]');
  io.stdout('  trust <project-id> | --all [--cwd <path>]');
  io.stdout('  watch [--interval <value>] [--once|--install|--start|--stop|--status] [--cwd <path>]');
  io.stdout('  pull [project-id] | --all [--install] [--cwd <path>]');
  io.stdout('  env sync <VAR...> [--fly] [--cwd <path>]');
  io.stdout('  restore <project-id> [--cwd <path>]');
  io.stdout('  sync-transcripts [project-id] [--all] [--cli <name>] [--since <window>] [--cwd <path>]');
  io.stdout('  restore-transcripts [project-id] [--all] [--last <window>] [--cwd <path>]');
  io.stdout('  analyze [project-id] [--all] [--last <window>] [--cwd <path>]');
  io.stdout('  push [--cwd <path>]');
  io.stdout('  brain push [--subset <types>] [--dry-run] [--cwd <path>]');
  io.stdout('  brain branch create|list|delete ...');
  io.stdout('  brain-db status [--json] [--cwd <path>]');
  io.stdout('  brain-db migrate [--cwd <path>]');
  io.stdout('  skills reindex | query … | show … | status [--json] | push | pull | diff [--cwd <path>]');
  io.stdout('  skills migrate --from static --to mech-storage [--dry-run] [--cwd <path>]');
  io.stdout('  app access grant <app> --project <id> [--cwd <path>]');
  io.stdout('  app access revoke <app> --project <id> [--cwd <path>]');
  io.stdout('  app access list [<app>] [--json] [--cwd <path>]');
  io.stdout('  machine-id [--json]');
}

export async function runNetworkCommand(argv, options = {}) {
  const io = {
    stdout: options.stdout || ((line) => console.log(line)),
    stderr: options.stderr || ((line) => console.error(line)),
  };

  if (!argv || argv.length === 0) {
    printHelp(io);
    return 0;
  }

  let command = argv[0];
  let args = argv.slice(1);

  // Async function: `status` awaits lifecycle helpers; other cases return sync numbers (wrapped as resolved promises).
  if (command === 'network') {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      printHelp(io);
      return 0;
    }
    command = args[0];
    args = args.slice(1);
  }

  if (command === '--help' || command === '-h' || command === 'help') {
    printHelp(io);
    return 0;
  }

  switch (command) {
    case 'status':
      return await runStatusCommand(args, io);
    case 'doctor':
      return runDoctorCommand(args, io);
    case 'sync':
      return runSyncCommand(args, io);
    case 'add':
      return runAddCommand(args, io);
    case 'install':
      return await runInstallCommand(args, io);
    case 'provision':
      return await runProvisionCommand(args, io);
    case 'trust':
      return runTrustCommand(args, io);
    case 'watch':
      return runWatchCommand(args, io);
    case 'pull':
      return runPullCommand(args, io);
    case 'env':
      return runEnvCommand(args, io);
    case 'restore':
      return runRestoreCommand(args, io);
    case 'sync-transcripts':
      return runSyncTranscriptsCommand(args, io);
    case 'restore-transcripts':
      return runRestoreTranscriptsCommand(args, io);
    case 'analyze':
      return runAnalyzeCommand(args, io);
    case 'brain':
      return runBrainCommand(args, io);
    case 'brain-db':
      return runBrainDbCommand(args, io);
    case 'push':
      return runNetworkPushCommand(args, io);
    case 'skills':
      return runSkillsCommand(args, io);
    case 'app':
      return runAppCommand(args, io);
    case 'machine-id':
      return runMachineIdCommand(args, io);
    default:
      io.stderr(`Unknown network command: ${command}`);
      printHelp(io);
      return 1;
  }
}
