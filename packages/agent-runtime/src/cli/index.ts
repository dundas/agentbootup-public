#!/usr/bin/env bun
/**
 * agent CLI — Process lifecycle management for agents
 *
 * This is a generic process manager. It knows nothing about messaging,
 * ADMP, or AgentDispatch. Those register into agent-runtime as services.
 *
 * Usage:
 *   agent start           Start the agent defined in cwd
 *   agent stop [name]     Stop an agent
 *   agent restart [name]  Restart an agent
 *   agent fleet           List all managed agents
 *   agent logs [name]     Stream agent logs
 *   agent health [name]   Check agent health
 *   agent remove [name]   Stop and delete an agent from fleet
 */

import { cmdStart } from './commands/start';
import { cmdStop } from './commands/stop';
import { cmdRestart } from './commands/restart';
import { cmdFleet } from './commands/fleet';
import { cmdLogs } from './commands/logs';
import { cmdHealth } from './commands/health';
import { cmdRemove } from './commands/remove';
import { cmdInstall } from './commands/install';

const VERSION = '2.0.0';

function printHelp() {
  console.log(`
agent v${VERSION} — Process lifecycle management for agents

Usage:
  agent <command> [options]

Process Commands:
  install            Install service config (plist/unit/pm2) without starting
  start              Start the agent defined in agent.config.ts
  stop [name]        Stop an agent (defaults to cwd agent)
  restart [name]     Restart an agent
  remove [name]      Stop and uninstall an agent from fleet
  fleet              List all managed agents
  logs [name]        Tail agent logs
  health [name]      Check agent health endpoint

Options:
  --help, -h         Show this help
  --version, -v      Show version

Examples:
  agent install                  # Install service config (plist/unit/pm2)
  agent start                    # Install + start agent from agent.config.ts
  agent start --foreground       # Start in foreground (no daemon)
  agent fleet                    # Show all running agents
  agent logs decisive-gm         # Tail logs from decisive-gm
  agent logs -f decisive-gm      # Stream logs (follow mode)
  agent health mech-reader-brain # Check if agent is healthy
  agent stop decisive-gm         # Stop a specific agent
  agent remove decisive-gm       # Stop + uninstall from fleet

Messaging and dispatch are handled by AgentDispatch, which
registers into agent-runtime as a service/transport.
`);
}

const [command, ...args] = process.argv.slice(2);

if (!command || command === '--help' || command === '-h') {
  printHelp();
  process.exit(0);
}

if (command === '--version' || command === '-v') {
  console.log(`agent v${VERSION}`);
  process.exit(0);
}

try {
  switch (command) {
    case 'install':
      await cmdInstall();
      break;
    case 'start':
      await cmdStart(args);
      break;
    case 'stop':
      await cmdStop(args);
      break;
    case 'restart':
      await cmdRestart(args);
      break;
    case 'remove':
      await cmdRemove(args);
      break;
    case 'fleet':
      await cmdFleet(args);
      break;
    case 'logs':
      await cmdLogs(args);
      break;
    case 'health':
      await cmdHealth(args);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run "agent --help" for usage.');
      process.exit(1);
  }
} catch (err: any) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
