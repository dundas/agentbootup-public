/**
 * Agent Configuration (v2 — Platform-Agnostic)
 *
 * Defines the agent.config.ts format and loader.
 * Each project creates an agent.config.ts in its root
 * with a default export from defineAgent().
 *
 * v2 changes: Platform-agnostic process config fields.
 * Old pm2-specific fields (autorestart, max_restarts, etc.) are
 * renamed to match the library API (restart, maxRestarts, etc.).
 */

import { existsSync } from 'fs';
import { join, resolve } from 'path';
import type { AgentConfig } from './agent';
import type { AgentStartConfig } from './platform/interface';

// ─── Types ──────────────────────────────────────────────

export interface AgentProcessConfig {
  /** Auto-restart on crash. Default: true */
  restart?: boolean;
  /** Maximum number of restarts. Default: 10 */
  maxRestarts?: number;
  /** Backoff delay between restarts (ms). Default: 1000 */
  restartBackoff?: number;
  /** Restart if memory exceeds this (e.g. '500M'). */
  maxMemory?: string;
}

export interface AgentDefinition extends AgentConfig {
  /** Custom entrypoint script (for wrapping existing daemons). */
  entrypoint?: string;
  /** Process management options. */
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
 *   process: { restart: true, maxMemory: '500M' },
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
 * Convert an AgentDefinition to an AgentStartConfig for the library API.
 * This bridges the config file format with the platform abstraction.
 */
export function toAgentStartConfig(config: AgentDefinition): AgentStartConfig {
  const script = config.entrypoint ?? findConfigPath() ?? '';

  return {
    name: config.name,
    script,
    port: config.port,
    interpreter: 'bun',
    env: {
      AGENT_NAME: config.name,
      ...(config.port ? { AGENT_PORT: String(config.port) } : {}),
      AGENT_CONFIG_DIR: process.cwd(),
    },
    workingDirectory: process.cwd(),
    restart: config.process?.restart ?? true,
    maxMemory: config.process?.maxMemory,
    maxRestarts: config.process?.maxRestarts ?? 10,
    restartBackoff: config.process?.restartBackoff ?? 1000,
  };
}
