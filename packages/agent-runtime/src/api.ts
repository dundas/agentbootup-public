/**
 * Library API — Primary Interface for v2
 *
 * Products import these functions directly:
 *   import { agentStart, agentStop, agentStatus } from '@dundas/agent-runtime';
 *
 * Each function delegates to the appropriate platform ProcessManager
 * (launchd on macOS, systemd on Linux, pm2 on Windows).
 */

import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { getProcessManager } from './platform';
import type {
  AgentHandle,
  AgentStartConfig,
  AgentStatusInfo,
  LogOptions,
} from './platform/interface';

// ─── Validation ──────────────────────────────────────────────

const NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;
const MAX_NAME_LENGTH = 64;

function validateName(name: string): void {
  if (!name || name.length === 0) {
    throw new Error('Agent name is required');
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(`Agent name must be ${MAX_NAME_LENGTH} characters or less`);
  }
  if (!NAME_REGEX.test(name)) {
    throw new Error(
      'Agent name must contain only alphanumeric characters and hyphens, and start with alphanumeric'
    );
  }
}

function validateConfig(config: AgentStartConfig): void {
  validateName(config.name);

  if (!config.script) {
    throw new Error('Agent script path is required');
  }

  // Resolve script path
  const scriptPath = config.workingDirectory
    ? resolve(config.workingDirectory, config.script)
    : resolve(config.script);

  if (!existsSync(scriptPath) && !existsSync(config.script)) {
    throw new Error(`Script not found: ${config.script}`);
  }

  if (config.port !== undefined) {
    if (config.port < 1024 || config.port > 65535) {
      throw new Error('Port must be between 1024 and 65535');
    }
  }
}

// ─── Library Functions ───────────────────────────────────────

/**
 * Start an agent as a background daemon.
 * Creates platform-native service config (plist/unit/pm2) and starts it.
 */
export async function agentStart(config: AgentStartConfig): Promise<AgentHandle> {
  validateConfig(config);
  const manager = await getProcessManager();

  // Install (idempotent — if already installed, overwrite config)
  await manager.install(config);

  // Start
  return manager.start(config.name);
}

/**
 * Stop a running agent by name.
 */
export async function agentStop(name: string): Promise<void> {
  validateName(name);
  const manager = await getProcessManager();
  await manager.stop(name);
}

/**
 * Restart a running agent by name.
 */
export async function agentRestart(name: string): Promise<void> {
  validateName(name);
  const manager = await getProcessManager();
  await manager.restart(name);
}

/**
 * Get status of a single agent.
 */
export async function agentStatus(name: string): Promise<AgentStatusInfo> {
  validateName(name);
  const manager = await getProcessManager();
  return manager.status(name);
}

/**
 * List all dundas agents across the fleet.
 */
export async function agentFleet(): Promise<AgentStatusInfo[]> {
  const manager = await getProcessManager();
  return manager.fleet();
}

/**
 * Stream or tail logs for an agent.
 */
export async function agentLogs(name: string, opts?: LogOptions): Promise<void> {
  validateName(name);
  const manager = await getProcessManager();
  await manager.logs(name, opts);
}

/**
 * Uninstall an agent (stop + remove service config).
 */
export async function agentUninstall(name: string): Promise<void> {
  validateName(name);
  const manager = await getProcessManager();
  await manager.uninstall(name);
}
