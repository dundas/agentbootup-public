/**
 * agent fleet — List all managed agents
 *
 * Options:
 *   --json    Output as JSON
 */

import { agentFleet } from '../../api';
import { parseArgs, formatTable } from '../util';

function formatDuration(ms?: number): string {
  if (!ms || ms <= 0) return '-';
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hours = Math.floor(min / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${min % 60}m`;
  if (min > 0) return `${min}m ${sec % 60}s`;
  return `${sec}s`;
}

export async function cmdFleet(args: string[]) {
  const { flags } = parseArgs(args);
  const json = flags['json'] === true;

  const list = await agentFleet();

  if (json) {
    console.log(JSON.stringify(list, null, 2));
    return;
  }

  if (list.length === 0) {
    console.log('No agents running. Start one with "agent start" in a project directory.');
    return;
  }

  const headers = ['Name', 'State', 'PID', 'Memory', 'Uptime', 'Platform', 'Restarts'];
  const rows = list.map(s => {
    const pid = s.pid ? String(s.pid) : '-';
    const mem = s.memory ?? '-';
    const uptime = formatDuration(s.uptime);
    const restarts = s.restarts !== undefined ? String(s.restarts) : '-';

    return [s.name, s.state, pid, mem, uptime, s.platform, restarts];
  });

  console.log('\n' + formatTable(headers, rows));

  const online = list.filter(s => s.state === 'online').length;
  const total = list.length;
  console.log(`\nTotal: ${total} agent(s) (${online} online, ${total - online} stopped)`);
}
