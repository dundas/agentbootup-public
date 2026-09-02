/**
 * Shared KNOWN_REPOS map — canonical agent-ID → local repo path mapping.
 *
 * Aligned with live ADMP registry (canonical names have no .gm suffix).
 * For backward compatibility, roundtable/orchestrator.ts creates .gm aliases.
 *
 * Used by morning-checkin.ts (headless brain spawning) and round-table.ts
 * (Agent-as-Brain pattern for RT participation).
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const DEV_DIR = process.env.DEV_DIR ?? join(homedir(), 'dev_env');

export const KNOWN_REPOS: Record<string, string> = {
  // Portfolio brains
  'agent-host':         join(DEV_DIR, 'agenthost'),
  'agent-process':      join(DEV_DIR, 'agent-process'),
  'agentanything':      join(DEV_DIR, 'agentanything'),
  'agentbeacon':        join(DEV_DIR, 'agentbeacon'),
  'agentdispatch':      join(DEV_DIR, 'agentdispatch'),
  'agentdrive':         join(DEV_DIR, 'agentdrive'),
  'atxcpr':             join(DEV_DIR, 'atxcpr'),
  'blankpost':          join(DEV_DIR, 'blankpost'),
  'bootup':             join(DEV_DIR, 'agentbootup'),
  'buildingfi':         join(DEV_DIR, 'buildingfi'),
  'circleinbox':        join(DEV_DIR, 'circleinbox'),
  'circledrive':        join(DEV_DIR, 'circledrive'),
  'circlesync':         join(DEV_DIR, 'circlesync'),
  'clearauth':          join(DEV_DIR, 'clearauth'),
  'decisive':           join(DEV_DIR, 'decisive_redux'),
  'derivative-labs':    join(DEV_DIR, 'derivative-labs'),
  'dkd-blog':           join(DEV_DIR, 'dkd_website'),
  'goodbuys':           join(DEV_DIR, 'goodcommerce', 'goodbuys'),
  'helloconvo':         join(DEV_DIR, 'helloconvo'),
  'helloconvo-media':   join(DEV_DIR, 'helloconvo-media'),
  'infinitrade':        join(DEV_DIR, 'infinitrade'),
  'liveport':           join(DEV_DIR, 'liveport'),
  'mech-apps':          join(DEV_DIR, 'mech', 'mech-apps'),
  'mech-browse':        join(DEV_DIR, 'mech', 'mech-browse'),
  'mech-client':        join(DEV_DIR, 'mech', 'mech-client'),
  'mech-libsql':        join(DEV_DIR, 'mech', 'mech-libsql'),
  'mech-llms':          join(DEV_DIR, 'mech', 'mech-llms'),
  'mech-machines':      join(DEV_DIR, 'mech', 'mech-machines'),
  'mech-media':         join(DEV_DIR, 'mech', 'mech-media'),
  'mech-plane':         join(DEV_DIR, 'mech', 'mech-plane'),
  'mech-push':          join(DEV_DIR, 'mech', 'mech-push'),
  'mech-queue':         join(DEV_DIR, 'mech', 'mech-queue'),
  'mech-registry':      join(DEV_DIR, 'mech', 'mech-registry'),
  'mech-sequences':     join(DEV_DIR, 'mech', 'mech-sequences'),
  'mech-reader':        join(DEV_DIR, 'mech', 'mech-reader'),
  'mech-run':           join(DEV_DIR, 'mech', 'mech-run'),
  'mech-search':        join(DEV_DIR, 'mech', 'mech-search'),
  'mech-storage':       join(DEV_DIR, 'mech', 'mech-storage'),
  'mech-vault':         join(DEV_DIR, 'mech', 'mech-vault'),
  'mech-watchdog':      join(DEV_DIR, 'mech', 'mech-watchdog'),
  'narrate':            join(DEV_DIR, 'narrate'),
  'ohok':               join(DEV_DIR, 'ohok'),
  'seedid':             join(DEV_DIR, 'seedid'),
  'signal':             join(DEV_DIR, 'signal'),
  'teleporter':         join(DEV_DIR, 'teleporter', 'teleportation'),
  'true-markets':       join(DEV_DIR, 'true_markets_mm'),
  'uhr':                join(DEV_DIR, 'uhr'),

  // Legacy aliases (for backward compatibility)
  'mech-watchdog.gm':   join(DEV_DIR, 'mech', 'mech-watchdog'), // old alias
  'agent-process-gm':   join(DEV_DIR, 'agent-process'), // ADMP registered without dot
};

/** Resolve agent ID to local repo path. Returns null if not found or repo doesn't exist on disk. */
export function resolveRepo(agentId: string): string | null {
  const repoPath = KNOWN_REPOS[agentId];
  if (!repoPath) return null;
  return existsSync(repoPath) ? repoPath : null;
}
