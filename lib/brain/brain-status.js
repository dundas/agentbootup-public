/**
 * Brain status command - reports install state, daemon health, last sync, manifest version
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import { enumerateMounts } from './mount-engine.js';
import { getApprovalFlowMode } from './mount-record.js';

const DAEMON_PORT = 8765;
const DAEMON_HOST = 'localhost';

/**
 * @param {string[]} args argv after `status`
 * @param {{ stdout: function, stderr: function }} io
 * @returns {number} exit code
 */
export async function runBrainStatus(args, io) {
  const brainId = args[0];

  if (!brainId) {
    io.stderr('Usage: agentbootup status <brain-id>');
    return 1;
  }

  // Find the mount for this brain
  const mounts = enumerateMounts();
  const mount = mounts.find(m => m.record?.brain_id === brainId || m.brainKey === brainId);

  if (!mount) {
    io.stdout(JSON.stringify({
      brain_id: brainId,
      installed: false,
      message: 'Brain not mounted'
    }, null, 2));
    return 0;
  }

  // Check daemon health via HTTP
  let daemonHealth = null;
  try {
    daemonHealth = await checkDaemonHealth();
  } catch {
    daemonHealth = { running: false, error: 'Daemon not accessible' };
  }

  // Check for sync data in mount
  const syncDir = path.join(mount.mountRoot, '.sync');
  let lastSync = null;
  let syncCount = 0;

  if (fs.existsSync(syncDir)) {
    try {
      const syncFiles = fs.readdirSync(syncDir);
      syncCount = syncFiles.length;

      // Get most recent sync timestamp from files or mount record
      const stats = syncFiles
        .map(f => {
          try {
            return fs.statSync(path.join(syncDir, f));
          } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

      if (stats.length > 0) {
        lastSync = stats[0].mtime.toISOString();
      }
    } catch {
      // Ignore sync dir errors
    }
  }

  // Check for manifest
  const manifestPath = path.join(mount.mountRoot, '.brain', 'manifest.json');
  let manifestVersion = null;
  let manifest = null;

  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      manifestVersion = manifest.version || manifest.meta?.version;
    } catch {
      // Ignore manifest parse errors
    }
  }

  // Check for agent card
  const cardPath = path.join(mount.mountRoot, '.brain', 'agent-card.json');
  let hasAgentCard = fs.existsSync(cardPath);
  const normalizedRecord = mount.record;

  const status = {
    brain_id: brainId,
    installed: true,
    mount: {
      root: mount.mountRoot,
      environment: mount.envName,
      mounted_at: normalizedRecord?.mounted_at,
      mount_kind: normalizedRecord?.mount_kind,
      live: normalizedRecord?.live === true,
      watcher_status: normalizedRecord?.watcher_status,
      last_synced_at: normalizedRecord?.last_synced_at,
      cwd: normalizedRecord?.cwd,
    },
    daemon: {
      healthy: daemonHealth?.healthy || false,
      running: daemonHealth?.running || false,
    },
    sync: {
      last_sync: lastSync,
      sync_count: syncCount,
    },
    manifest: {
      version: manifestVersion,
      present: !!manifest,
    },
    agent_card: {
      present: hasAgentCard,
    },
    environment: {
      name: normalizedRecord?.environment?.name,
      mechanism: getApprovalFlowMode(normalizedRecord),
      config_hash: normalizedRecord?.environment?.config_hash
        ? normalizedRecord.environment.config_hash.slice(0, 12) + '...'
        : null,
    },
  };

  io.stdout(JSON.stringify(status, null, 2));
  return 0;
}

/**
 * Check daemon health via HTTP
 */
function checkDaemonHealth() {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://${DAEMON_HOST}:${DAEMON_PORT}/health`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({
            healthy: parsed.healthy === true,
            running: res.statusCode === 200
          });
        } catch {
          resolve({ healthy: false, running: res.statusCode === 200 });
        }
      });
    });

    req.on('error', () => {
      reject(new Error('Daemon not accessible'));
    });

    req.setTimeout(2000, () => {
      req.destroy();
      reject(new Error('Daemon timeout'));
    });
  });
}
