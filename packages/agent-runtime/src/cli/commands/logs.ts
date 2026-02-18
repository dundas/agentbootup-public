/**
 * agent logs [name] — Stream agent logs
 *
 * Options:
 *   --follow, -f    Follow/stream mode
 *   --lines N       Number of lines (default: 50)
 *   --err           Show stderr only
 */

import { agentLogs } from '../../api';
import { parseArgs, resolveAgentName } from '../util';
import type { LogOptions } from '../../platform/interface';

export async function cmdLogs(args: string[]) {
  const { flags } = parseArgs(args);
  const follow = flags['follow'] === true || flags['f'] === true;
  const errOnly = flags['err'] === true;
  const lines = typeof flags['lines'] === 'string' ? parseInt(flags['lines'], 10) : 50;

  const [name] = await resolveAgentName(args);

  const opts: LogOptions = {
    follow,
    lines,
    level: errOnly ? 'stderr' : 'all',
  };

  if (follow) {
    console.log(`Streaming logs for ${name} (Ctrl+C to stop)...\n`);
  }

  await agentLogs(name, opts);
}
