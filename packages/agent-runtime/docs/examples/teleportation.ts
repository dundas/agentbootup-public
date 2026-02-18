/**
 * Example: Teleportation Integration
 *
 * Shows how teleportation replaces its custom 524-line daemon lifecycle
 * with ~20 lines of agent-runtime library calls.
 */

import { agentStart, agentStop, agentStatus, agentFleet } from '@dundas/agent-runtime';
import { resolve } from 'path';

// ─── CLI Commands ────────────────────────────────────────

export async function awayCommand() {
  const handle = await agentStart({
    name: 'teleportation-daemon',
    script: resolve(__dirname, '../daemon/index.ts'),
    port: 3050,
    interpreter: 'bun',
    env: {
      TELEPORTATION_API_KEY: process.env.TELEPORTATION_API_KEY!,
      NODE_ENV: 'production',
    },
    restart: true,
    maxMemory: '300M',
  });

  console.log(`Teleportation daemon started (PID: ${handle.pid})`);
  console.log(`Health: http://localhost:3050/health`);
  console.log(`Platform: ${handle.platform}`);
}

export async function hereCommand() {
  await agentStop('teleportation-daemon');
  console.log('Teleportation daemon stopped');
}

export async function statusCommand() {
  const info = await agentStatus('teleportation-daemon');
  console.log(`Status: ${info.state}`);
  if (info.pid) console.log(`PID: ${info.pid}, Memory: ${info.memory}`);
}
