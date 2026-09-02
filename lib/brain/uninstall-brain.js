/**
 * `agentbootup uninstall <brain>` — push brain assets, stop daemons, remove from network config; optional --purge.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { agentStop } from '@derivativelabs/agent-process';
import { getNetworkRoot } from '../config/config.js';
import { loadNetworkConfig, saveNetworkConfig } from '../network/config.js';
import { getPositionalArgs, hasFlag } from '../network/args.js';
import { runBrainPush } from '../network/commands/brain.js';
import {
  getBrainAgentEntries,
  getBrainDbAgentEntries,
  getInboxAgentEntries,
  getCustomAgentEntries,
} from '../daemon/daemon-registry.js';

/**
 * @param {string[]} argv
 * @param {{ stdout: (s: string) => void, stderr: (s: string) => void }} io
 * @returns {Promise<number>}
 */
export async function runUninstallBrain(argv, io) {
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    io.stdout('Usage: agentbootup uninstall <brain> [--dry-run] [--yes] [--purge] [--skip-push]');
    io.stdout('');
    io.stdout('  1) brain push (sync local assets to server), unless --skip-push');
    io.stdout('  2) stop per-project daemons (brain, brain-db, inbox, custom)');
    io.stdout('  3) --purge: delete linked project directory (requires --yes), before config update');
    io.stdout('  4) remove project entry from network agentbootup.json');
    io.stdout('');
    io.stdout('  --skip-push: continue if push is impossible (offline / auth); risks data loss.');
    io.stdout('  Cannot combine --purge with --skip-push (would delete local copy without server backup).');
    io.stdout('  Destructive: use --dry-run first.');
    return 0;
  }

  const dryRun = hasFlag(argv, '--dry-run');
  const yes = hasFlag(argv, '--yes');
  const purge = hasFlag(argv, '--purge');
  const skipPush = hasFlag(argv, '--skip-push');

  const positionals = getPositionalArgs(argv);
  const agentRef = positionals[0];
  if (!agentRef) {
    io.stderr('uninstall failed: missing <brain> (project id or agent_id)');
    return 1;
  }

  if (purge && !yes && !dryRun) {
    io.stderr('uninstall failed: --purge requires --yes (or use --dry-run)');
    return 1;
  }

  if (purge && skipPush) {
    io.stderr(
      'uninstall failed: --purge cannot be combined with --skip-push (data-loss: no server copy of local changes). Push first, or omit --purge.'
    );
    return 1;
  }

  const networkRoot = await getNetworkRoot();
  if (!networkRoot) {
    io.stderr('uninstall failed: config set-network-root <path> first');
    return 1;
  }

  let config;
  try {
    const loaded = loadNetworkConfig(networkRoot);
    config = loaded.config;
  } catch (e) {
    io.stderr(`uninstall failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  if (config.role !== 'network') {
    io.stderr('uninstall failed: network portfolio config required');
    return 1;
  }

  const projects = config.projects || [];
  const idx = projects.findIndex((p) => p.agent_id === agentRef || p.id === agentRef);
  if (idx === -1) {
    io.stderr(`uninstall failed: no project "${agentRef}"`);
    return 1;
  }

  const project = projects[idx];
  const projectRoot = typeof project.path === 'string' ? project.path : null;
  const onDisk = projectRoot && fs.existsSync(projectRoot);

  io.stdout(`uninstall: ${project.agent_id} (${project.id})`);
  if (dryRun) {
    io.stdout('  dry-run: would brain push → stop daemons → purge (if --purge) → remove from network config');
    if (purge && projectRoot) io.stdout(`  dry-run: would purge directory ${projectRoot}`);
    return 0;
  }

  if (onDisk && projectRoot) {
    if (skipPush) {
      io.stderr('  warning: --skip-push — not uploading local assets; server may be missing latest changes');
    } else {
      io.stdout('  pushing brain assets…');
      const code = await runBrainPush([], io, projectRoot);
      if (code !== 0) {
        io.stderr('uninstall failed: brain push did not complete (retry or pass --skip-push if offline)');
        return 1;
      }
    }
  } else {
    io.stdout('  skip push: no local checkout');
  }

  const filterKey = project.id;
  const toStop = [
    ...(await getBrainAgentEntries()),
    ...(await getBrainDbAgentEntries()),
    ...(await getInboxAgentEntries({ allocate: false })),
    ...(await getCustomAgentEntries()),
  ].filter((e) => e.key === filterKey || e.projectId === filterKey);

  io.stdout('  stopping daemons…');
  for (const e of toStop) {
    try {
      await agentStop(e.name);
      io.stdout(`    stopped ${e.name}`);
    } catch (err) {
      const msg = String(err?.message ?? err).toLowerCase();
      if (
        msg.includes('not loaded') ||
        msg.includes('not found') ||
        msg.includes('not running') ||
        msg.includes('no such')
      ) {
        io.stdout(`    ${e.name}: not running`);
      } else {
        io.stderr(`    warning: failed to stop ${e.name}: ${err?.message ?? err}`);
      }
    }
  }

  if (purge && projectRoot && onDisk && yes) {
    const resolved = path.resolve(projectRoot);
    const home = path.resolve(os.homedir());
    if (resolved === path.parse(resolved).root || resolved === home) {
      io.stderr('uninstall failed: refusing to purge filesystem root or home directory');
      return 1;
    }
    try {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      io.stdout(`  purged ${projectRoot}`);
    } catch (e) {
      io.stderr(
        `uninstall failed: could not purge directory: ${e instanceof Error ? e.message : String(e)} — config unchanged; fix permissions and retry`
      );
      return 1;
    }
  }

  const nextProjects = projects.filter((_, i) => i !== idx);
  const nextConfig = { ...config, projects: nextProjects };

  try {
    saveNetworkConfig(nextConfig, networkRoot);
  } catch (e) {
    io.stderr(`uninstall failed: could not save config: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  io.stdout('  removed from network config');

  io.stdout('Done.');
  return 0;
}
