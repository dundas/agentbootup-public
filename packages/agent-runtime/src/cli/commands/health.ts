/**
 * agent health [name] — Check agent health endpoint
 */

import { agentStatus } from '../../api';
import { resolveAgentName } from '../util';

export async function cmdHealth(args: string[]) {
  const [name] = await resolveAgentName(args);
  const info = await agentStatus(name);

  if (info.state !== 'online') {
    console.log(`${name}: not running (state: ${info.state})`);
    process.exit(1);
  }

  if (!info.port) {
    console.log(`${name}: online (pid: ${info.pid}), but no port configured — cannot probe health.`);
    return;
  }

  try {
    const res = await fetch(`http://localhost:${info.port}/health`, {
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      console.log(`${name}: healthy`);
      console.log(`  Platform: ${info.platform}`);
      console.log(`  Port: ${info.port}`);
      if (info.pid) console.log(`  PID: ${info.pid}`);
      if (info.memory) console.log(`  Memory: ${info.memory}`);

      // Try /status for more detail
      try {
        const statusRes = await fetch(`http://localhost:${info.port}/status`, {
          signal: AbortSignal.timeout(5000),
        });
        if (statusRes.ok) {
          const status = (await statusRes.json()) as any;
          if (status.uptime) {
            const uptimeSec = Math.floor(status.uptime / 1000);
            const min = Math.floor(uptimeSec / 60);
            const hours = Math.floor(min / 60);
            console.log(`  Uptime: ${hours}h ${min % 60}m`);
          }
          if (status.services) {
            for (const [svc, s] of Object.entries(status.services) as [string, any][]) {
              console.log(`  Service "${svc}": ${s.running ? 'running' : 'stopped'}`);
            }
          }
        }
      } catch {
        // /status not available — that's fine
      }
    } else {
      console.log(`${name}: unhealthy (HTTP ${res.status})`);
      process.exit(1);
    }
  } catch (err: any) {
    console.log(`${name}: online (pid: ${info.pid}) but health endpoint unreachable on port ${info.port}`);
    console.log(`  Error: ${err.message}`);
    process.exit(1);
  }
}
