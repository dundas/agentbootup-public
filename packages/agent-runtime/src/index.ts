/**
 * @dundas/agent-runtime v2.0
 *
 * Standardized agent daemon runtime for portfolio brains.
 * Library-first API with platform-native process management.
 *
 * Library usage (recommended for products):
 *   import { agentStart, agentStop, agentStatus } from '@dundas/agent-runtime';
 *
 *   const handle = await agentStart({
 *     name: 'my-agent',
 *     script: './src/daemon.ts',
 *     port: 3050,
 *   });
 *
 * In-process usage (for the agent process itself):
 *   import { createAgent } from '@dundas/agent-runtime';
 *   import { HeartbeatService } from '@dundas/agent-runtime/services';
 *
 *   const agent = createAgent({ name: 'my-brain', port: 8080, services: [...] });
 *   await agent.start();
 */

// ─── Library API (v2 primary interface) ──────────────────────
export {
  agentStart,
  agentStop,
  agentRestart,
  agentStatus,
  agentFleet,
  agentLogs,
  agentUninstall,
} from './api';

// ─── Platform Abstraction ────────────────────────────────────
export { getProcessManager, getPlatform, isWSL, resolveBunPath, buildServicePath } from './platform';
export type {
  Platform,
  ProcessManager,
  AgentStartConfig,
  AgentHandle,
  AgentStatusInfo,
  LogOptions,
} from './platform';

// ─── Core (in-process agent) ─────────────────────────────────
export { Agent, createAgent } from './agent';
export type { AgentConfig } from './agent';

// Lifecycle
export { acquireLock, releaseLock, setupSignals } from './lifecycle';
export type { ProcessLock, LockOptions, SignalCallbacks } from './lifecycle';

// Server
export { AgentServer } from './server';
export type { AgentServerConfig, AgentStatus, Route, RouteHandler } from './server';

// Service interface
export type { Service, ServiceContext, Transport, TransportMessage } from './service';

// Services (re-export for convenience)
export { HeartbeatService } from './services/heartbeat';
export { MessageService } from './services/message';

// Transports (re-export for convenience)
export { ADMPTransport } from './transports/admp';

// ─── Config (v2 — platform-agnostic) ─────────────────────────
export {
  defineAgent as defineAgentV2,
  loadConfig as loadConfigV2,
  findConfigPath as findConfigPathV2,
  toAgentStartConfig,
} from './config';
export type {
  AgentDefinition as AgentDefinitionV2,
  AgentProcessConfig as AgentProcessConfigV2,
} from './config';

// ─── Legacy Process Management (v1 compat — deprecated) ──────
// These exports are kept for backward compatibility with v1 configs.
// New code should use the v2 Library API (agentStart/agentStop) and
// v2 Config (defineAgentV2/toAgentStartConfig) above.
/** @deprecated Use v2 Library API instead */
export { PM2, defineAgent, loadConfig, findConfigPath, toStartOptions } from './process';
/** @deprecated Use AgentDefinitionV2, AgentProcessConfigV2 instead */
export type { AgentDefinition, AgentProcessConfig } from './process';
