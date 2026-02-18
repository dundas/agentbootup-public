/**
 * Example: AgentDispatch Integration
 *
 * Shows how AgentDispatch uses agent-runtime to manage its inbox processor.
 */

import { agentStart, agentStop, agentStatus } from '@dundas/agent-runtime';
import { resolve } from 'path';

export async function startInbox() {
  const handle = await agentStart({
    name: 'agentdispatch-inbox',
    script: resolve(__dirname, '../inbox/processor.ts'),
    port: 4200,
    env: {
      DISPATCH_HUB_URL: process.env.DISPATCH_HUB_URL!,
      NODE_ENV: 'production',
    },
    restart: true,
    maxMemory: '256M',
    maxRestarts: 5,
  });

  console.log(`AgentDispatch inbox started (PID: ${handle.pid})`);
}

export async function stopInbox() {
  await agentStop('agentdispatch-inbox');
  console.log('AgentDispatch inbox stopped');
}
