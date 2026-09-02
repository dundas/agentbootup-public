/**
 * Per-brain lifecycle status for `agentbootup status <brain>` (network portfolio).
 */

import fs from 'fs';
import path from 'path';
import { agentStatus } from '@derivativelabs/agent-process';
import { loadNetworkConfig } from '../network/config.js';
import { getAgentId } from '../project-config.js';
import {
  getBrainAgentEntries,
  getBrainDbAgentEntries,
  getInboxAgentEntries,
  getCustomAgentEntries,
} from '../daemon/daemon-registry.js';
import { enumerateMounts, envConfigHashMatchesDisk } from './mount-engine.js';
import { getApprovalFlowMode } from './mount-record.js';

/**
 * @param {string} ref — project `id` or `agent_id`
 * @param {string} networkRoot
 * @param {{ stdout: (s: string) => void, stderr: (s: string) => void }} io
 * @returns {number} exit code
 */
export async function printBrainLifecycleStatus(ref, networkRoot, io) {
  let config;
  try {
    ({ config } = loadNetworkConfig(networkRoot));
  } catch (e) {
    io.stderr(`status failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  if (config.role !== 'network') {
    io.stderr('status <brain> requires a network portfolio agentbootup.json.');
    return 1;
  }

  const projects = config.projects || [];
  const project = projects.find((p) => p.id === ref || p.agent_id === ref);
  if (!project) {
    io.stderr(`status failed: no project with id or agent_id "${ref}"`);
    return 1;
  }

  const resolvedPath =
    typeof project.path === 'string' && project.path.length > 0 ? project.path : null;
  const onDisk = resolvedPath && fs.existsSync(resolvedPath);

  io.stdout(`Brain status: ${project.agent_id} (${project.id})`);
  io.stdout(`  Path: ${resolvedPath || '(not linked)'}`);
  io.stdout(`  Linked: ${onDisk ? 'yes' : 'no'}`);

  let manifestVersion = '';
  if (onDisk && resolvedPath) {
    const pj = path.join(resolvedPath, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(pj, 'utf-8'));
      if (typeof pkg.version === 'string') manifestVersion = pkg.version;
    } catch {
      // optional
    }
    const aid = getAgentId(resolvedPath);
    io.stdout(`  agent_id (project): ${aid || '(missing)'}`);
  }
  if (manifestVersion) io.stdout(`  package.json version: ${manifestVersion}`);

  const filterKey = project.id;

  const sections = [
    ...(await getBrainAgentEntries()),
    ...(await getBrainDbAgentEntries()),
    ...(await getInboxAgentEntries({ allocate: false })),
    ...(await getCustomAgentEntries()),
  ].filter((e) => e.key === filterKey || e.projectId === filterKey);

  io.stdout('  Daemons:');
  if (sections.length === 0) {
    io.stdout('    (none registered for this project)');
  }
  for (const e of sections) {
    try {
      const st = await agentStatus(e.name);
      const line =
        st.state === 'online' && st.pid
          ? `online pid=${st.pid}`
          : `${st.state || 'unknown'}`;
      io.stdout(`    ${e.name}: ${line}`);
    } catch {
      io.stdout(`    ${e.name}: not running`);
    }
  }

  const mountRows = enumerateMounts().filter(
    (m) => m.brainKey === project.id || m.record?.brain_id === project.agent_id
  );
  if (mountRows.length > 0) {
    io.stdout('  Environment mounts:');
    for (const m of mountRows) {
      const normalizedRecord = m.record;
      const cfgPath = m.record?.environment?.config_path;
      let hashStatus = 'unknown';
      if (cfgPath && fs.existsSync(cfgPath)) {
        hashStatus = envConfigHashMatchesDisk(cfgPath, normalizedRecord);
      } else if (cfgPath) {
        hashStatus = 'missing_config';
      }
      const mech = getApprovalFlowMode(normalizedRecord) ?? '(unknown)';
      io.stdout(
        `    ${m.envName}: kind=${normalizedRecord?.mount_kind} live=${normalizedRecord?.live === true ? 'yes' : 'no'} watcher=${normalizedRecord?.watcher_status} mechanism=${mech} config_hash=${hashStatus} path=${m.mountRoot}`
      );
    }
  }

  io.stdout('  Note: "last sync" for transcripts/brain assets is tracked per file in ~/.agentbootup/sync-state.json');
  io.stdout('          and server-side — use `agentbootup brain verify --cwd <project>` for drift.');
  return 0;
}
