/**
 * agent stop [name] — Stop an agent
 */

import { agentStop, agentStatus } from '../../api';
import { resolveAgentName } from '../util';

export async function cmdStop(args: string[]) {
  const [name] = await resolveAgentName(args);

  // Check current status
  const info = await agentStatus(name);
  if (info.state === 'stopped' || info.state === 'unknown') {
    console.log(`${name} is already stopped.`);
    return;
  }

  await agentStop(name);
  console.log(`${name} stopped.`);
}
