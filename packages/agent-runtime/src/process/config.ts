/**
 * Agent Configuration
 *
 * Defines the agent.config.ts format and loader.
 * Each project that wants to be managed by the `agent` CLI
 * creates an agent.config.ts in its root with a default export
 * from defineAgent().
 */

import { existsSync } from 'fs';
import { join, resolve } from 'path';
import type { AgentConfig } from '../agent';
import type { StartOptions } from './pm2-wrapper';

// ─── Types ──────────────────────────────────────────────

export interface AgentProcessConfig {
  /** Auto-restart on crash. Default: true */
  autorestart?: boolean;
  /** Maximum number of restarts. Default: 10 */
  max_restarts?: number;
  /** Exponential backoff delay for restarts (ms). Default: 1000 */
  exp_backoff_restart_delay?: number;
  /** Restart if memory exceeds this (e.g. '500M'). */
  max_memory_restart?: string;
  /** Watch for file changes. Default: false */
  watch?: boolean | string[];
  /** Patterns to ignore when watching. */
  ignore_watch?: string[];
  /** Time to wait before SIGKILL (ms). Default: 5000 */
  kill_timeout?: number;
}

export interface AgentDefinition extends AgentConfig {
  /** Custom entrypoint script (for wrapping existing daemons). */
  entrypoint?: string;
  /** pm2 process management options. */
  process?: AgentProcessConfig;
}

// ─── Factory ────────────────────────────────────────────

/**
 * Define an agent configuration. Use as the default export of agent.config.ts.
 *
 * @example
 * ```typescript
 * // agent.config.ts
 * import { defineAgent } from '@dundas/agent-runtime';
 *
 * export default defineAgent({
 *   name: 'my-brain',
 *   port: 3051,
 *   services: [...],
 *   process: { autorestart: true, max_memory_restart: '500M' },
 * });
 * ```
 */
export function defineAgent(config: AgentDefinition): AgentDefinition {
  return config;
}

// ─── Loader ─────────────────────────────────────────────

const CONFIG_FILENAMES = ['agent.config.ts', 'agent.config.js', 'agent.config.mjs'];

/**
 * Find and load agent.config.ts from a directory.
 * Searches for agent.config.{ts,js,mjs} in the given directory.
 */
export async function loadConfig(cwd?: string): Promise<AgentDefinition> {
  const dir = resolve(cwd || process.cwd());

  for (const filename of CONFIG_FILENAMES) {
    const configPath = join(dir, filename);
    if (existsSync(configPath)) {
      const mod = await import(configPath);
      const config = mod.default;
      if (!config || !config.name) {
        throw new Error(`${configPath}: default export must be a valid agent config with a 'name' field`);
      }
      return config;
    }
  }

  throw new Error(
    `No agent config found in ${dir}. Create one of: ${CONFIG_FILENAMES.join(', ')}`
  );
}

/**
 * Find the config file path without loading it.
 * Returns null if no config file exists.
 */
export function findConfigPath(cwd?: string): string | null {
  const dir = resolve(cwd || process.cwd());
  for (const filename of CONFIG_FILENAMES) {
    const configPath = join(dir, filename);
    if (existsSync(configPath)) {
      return configPath;
    }
  }
  return null;
}

// ─── Converters ─────────────────────────────────────────

/**
 * Convert an AgentDefinition into pm2 StartOptions.
 * Resolves the entrypoint and merges process config.
 */
export function toStartOptions(config: AgentDefinition, bootScriptPath: string): StartOptions {
  const script = config.entrypoint || bootScriptPath;
  const cwd = process.cwd();

  return {
    script,
    name: config.name,
    interpreter: 'bun',
    cwd,
    env: {
      AGENT_NAME: config.name,
      AGENT_PORT: String(config.port),
      AGENT_CONFIG_DIR: cwd,
      ...(config.process as any)?.env,
    },
    autorestart: config.process?.autorestart ?? true,
    max_restarts: config.process?.max_restarts ?? 10,
    exp_backoff_restart_delay: config.process?.exp_backoff_restart_delay ?? 1000,
    max_memory_restart: config.process?.max_memory_restart,
    watch: config.process?.watch ?? false,
    ignore_watch: config.process?.ignore_watch,
    kill_timeout: config.process?.kill_timeout ?? 5000,
  };
}
