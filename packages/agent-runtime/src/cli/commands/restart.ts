/**
 * agent restart [name] — Restart an agent
 */

import { agentRestart } from '../../api';
import { resolveAgentName } from '../util';

export async function cmdRestart(args: string[]) {
  const [name] = await resolveAgentName(args);
  await agentRestart(name);
  console.log(`${name} restarted.`);
}
