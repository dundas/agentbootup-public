/**
 * agent start — Start the agent defined in agent.config.ts
 *
 * Options:
 *   --foreground    Run in foreground (no pm2/launchd, for debugging)
 */

import { agentStart, agentStatus } from '../../api';
import { loadConfig, toAgentStartConfig } from '../../config';
import { getPlatform } from '../../platform';
import { parseArgs } from '../util';

export async function cmdStart(args: string[]) {
  const { flags } = parseArgs(args);
  const foreground = flags['foreground'] === true || flags['f'] === true;

  const config = await loadConfig();

  if (foreground) {
    // Run inline — import and start directly
    const { createAgent } = await import('../../agent');
    const agent = createAgent(config);
    await agent.start();
    return; // Agent keeps running
  }

  // Check if already running
  try {
    const existing = await agentStatus(config.name);
    if (existing.state === 'online') {
      console.log(`${config.name} is already running. Use "agent restart" to restart.`);
      return;
    }
  } catch {
    // Not found — proceed to start
  }

  const startConfig = toAgentStartConfig(config);
  const handle = await agentStart(startConfig);

  console.log(`${config.name} started`);
  console.log(`  PID: ${handle.pid > 0 ? handle.pid : 'pending'}`);
  console.log(`  Port: ${config.port ?? 'none'}`);
  console.log(`  Platform: ${handle.platform}`);
  if (config.port) {
    console.log(`  Health: http://localhost:${config.port}/health`);
  }
}
