/**
 * Example: Memory Sync Integration
 *
 * Shows how the agentbootup memory-sync daemon uses agent-runtime.
 */

import { agentStart, agentStop, agentStatus } from '@dundas/agent-runtime';
import { resolve } from 'path';

export async function startSync() {
  const handle = await agentStart({
    name: 'memory-sync',
    script: resolve(__dirname, '../sync/daemon.ts'),
    // No port needed — memory sync doesn't serve HTTP
    env: {
      SYNC_INTERVAL: '300000', // 5 minutes
      NODE_ENV: 'production',
    },
    restart: true,
    maxMemory: '128M',
  });

  console.log(`Memory sync daemon started (PID: ${handle.pid})`);
}

export async function stopSync() {
  await agentStop('memory-sync');
  console.log('Memory sync stopped');
}
