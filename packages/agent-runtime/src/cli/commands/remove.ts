/**
 * agent remove [name] — Stop and delete an agent from fleet
 */

import { agentUninstall } from '../../api';
import { resolveAgentName } from '../util';

export async function cmdRemove(args: string[]) {
  const [name] = await resolveAgentName(args);
  await agentUninstall(name);
  console.log(`${name} removed from fleet.`);
}
