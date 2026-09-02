/**
 * network push — push local agentbootup.json config to the server.
 *
 * Strips path fields from all projects before sending (paths are machine-local).
 * Uses merge semantics on the server (upsert by agent_id, never delete).
 */

import { extractCwd } from '../args.js';
import { loadNetworkConfig } from '../config.js';
import { readCredentials } from '../../auth/credentials.js';
import { pushNetworkConfig } from '../../sync/brains.js';

export async function runNetworkPushCommand(args, io) {
  const extracted = extractCwd(args);
  const cwd = extracted.cwd;

  let loaded;
  try {
    loaded = loadNetworkConfig(cwd);
  } catch (err) {
    io.stderr(`network push failed: ${err.message}`);
    return 1;
  }

  const { config } = loaded;
  if (config.role !== 'network') {
    io.stderr('network push failed: config is not a network config');
    return 1;
  }

  const creds = await readCredentials();
  if (!creds) {
    io.stderr('network push failed: no credentials — run: agentbootup auth login');
    return 1;
  }

  try {
    const result = await pushNetworkConfig(creds, config);
    io.stdout(`Pushed network config: ${result.projectCount} project(s) (paths stripped)`);
  } catch (err) {
    io.stderr(`network push failed: ${err.message}`);
    return 1;
  }

  return 0;
}
