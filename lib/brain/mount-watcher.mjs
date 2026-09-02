#!/usr/bin/env bun

import { runMountWatcherLoop } from './mount-watcher.js';

const mountRoot = process.env.AGENTBOOTUP_MOUNT_ROOT || '';
const sourceRoot = process.env.AGENTBOOTUP_SOURCE_ROOT || '';
const envConfigPath = process.env.AGENTBOOTUP_ENV_CONFIG_PATH || '';
const projectId = process.env.AGENTBOOTUP_PROJECT_ID || '';
const agentId = process.env.AGENTBOOTUP_AGENT_ID || '';
const intervalMs = Number(process.env.AGENTBOOTUP_MOUNT_WATCH_INTERVAL_MS || '1000');
const bypassApprovals = process.env.AGENTBOOTUP_MOUNT_BYPASS_APPROVALS === '1';

if (!mountRoot || !sourceRoot || !envConfigPath || !projectId || !agentId) {
  throw new Error('mount watcher missing required environment');
}

await runMountWatcherLoop({
  mountRoot,
  sourceRoot,
  envConfigPath,
  projectId,
  agentId,
  intervalMs,
  bypassApprovals,
  io: { stdout: () => {}, stderr: () => {} },
});
