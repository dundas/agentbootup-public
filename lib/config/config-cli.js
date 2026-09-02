/**
 * CLI handlers for `agentbootup config <sub-command>`.
 *
 * Sub-commands:
 *   set-brain <id>   Persist a brain ID used by the transcript sync daemon.
 *   set-converge <on|off> Persist the memory-converge default.
 *   show             Print all stored config values.
 *   list-brains      List all brains registered under the current API key.
 */

import path from 'path';
import fs from 'fs';
import { readConfig, setBrainId, setMemoryConvergeEnabled, setNetworkRoot } from './config.js';
import { isValidBrainId, MAX_BRAIN_ID_LENGTH } from './brain-id.js';
import {
  readCredentials,
  inspectCredentials,
  CREDS_STATE_OK,
  formatCredentialsRecoveryMessage,
} from '../auth/credentials.js';
import { listBrains, fetchNetworkConfig } from '../sync/brains.js';

/**
 * @param {string[]} argv  Full argv passed to the config command (argv[0] === 'config').
 */
export async function runConfigCommand(argv) {
  const sub = argv[1];

  if (sub === 'set-brain') {
    const brainId = argv[2];
    if (!brainId) {
      console.error('Usage: agentbootup config set-brain <brain-id>');
      process.exit(1);
    }
    if (!isValidBrainId(brainId)) {
      console.error(
        `Invalid brain ID "${brainId}". Must be 1-${MAX_BRAIN_ID_LENGTH} characters using alphanumerics, underscores, hyphens, and dot-separated segments only.`
      );
      process.exit(1);
    }
    await setBrainId(brainId);
    console.log(`Brain ID set: ${brainId}`);
    return;
  }

  if (sub === 'show') {
    const config = await readConfig();
    if (!Object.keys(config).length) {
      console.log('No configuration stored. Run `agentbootup config set-brain <id>` to configure.');
      return;
    }
    for (const [k, v] of Object.entries(config)) {
      console.log(`  ${k}: ${v}`);
    }
    return;
  }

  if (sub === 'set-converge') {
    const value = argv[2];
    if (value !== 'on' && value !== 'off') {
      console.error('Usage: agentbootup config set-converge <on|off>');
      process.exit(1);
    }
    await setMemoryConvergeEnabled(value === 'on');
    console.log(`Memory converge set: ${value}`);
    return;
  }

  if (sub === 'list-brains') {
    const credentialState = await inspectCredentials();
    if (credentialState.state !== CREDS_STATE_OK) {
      console.error(formatCredentialsRecoveryMessage(credentialState));
      process.exit(1);
    }
    const creds = credentialState.creds;
    let brains;
    try {
      brains = await listBrains(creds);
    } catch (err) {
      console.error(`Failed to fetch brains: ${err.message}`);
      process.exit(1);
    }
    if (brains.length === 0) {
      console.log(
        'No brains registered on the current server. ' +
        'Local brain links or cross-brain messaging (ADMP) registration do not create server-side restore entries.',
      );
      console.log('Visit the agentbootup dashboard or server registration flow to create one.');
      return;
    }
    console.log(`Brains registered under your API key (${creds.serverUrl}):\n`);
    for (const b of brains) {
      const label = b.name ? `${b.id}  (${b.name})` : b.id;
      console.log(`  ${label}`);
      if (b.description) console.log(`    ${b.description}`);
    }
    console.log(`\nTo use a brain: agentbootup config set-brain <id>`);
    return;
  }

  if (sub === 'set-network-root') {
    const rootPath = argv[2];
    if (!rootPath) {
      console.error('Usage: agentbootup config set-network-root <path>');
      process.exit(1);
    }
    const force = argv.includes('--force');
    const resolved = path.resolve(rootPath);
    const configPath = path.join(resolved, 'agentbootup.json');

    if (fs.existsSync(configPath) && !force) {
      console.log(`Using existing config at ${configPath}`);
    } else {
      fs.mkdirSync(resolved, { recursive: true });

      // Try pulling config from server if credentials exist
      let pulled = false;
      try {
        const creds = await readCredentials();
        if (creds) {
          const serverConfig = await fetchNetworkConfig(creds);
          if (serverConfig) {
            fs.writeFileSync(configPath, JSON.stringify(serverConfig, null, 2) + '\n');
            const projectCount = (serverConfig.projects || []).length;
            console.log(`Pulled network config from server: ${projectCount} brain(s) registered (0 linked)`);
            console.log(`Use 'agentbootup brain link <agent-id> --path <dir>' to link brains to local directories`);
            pulled = true;
          }
        }
      } catch (err) {
        // Server pull failed — fall back to empty config, log so users know
        console.log(`Could not pull config from server (${err.message}), creating empty config`);
      }

      if (!pulled) {
        fs.writeFileSync(configPath, JSON.stringify({ version: '2.0', role: 'network', projects: [] }, null, 2) + '\n');
        console.log(`Created ${configPath}`);
      }
    }

    await setNetworkRoot(resolved);
    console.log(`Network root set: ${resolved}`);
    return;
  }

  if (sub) {
    console.error(`Unknown config subcommand: "${sub}"`);
  }
  console.error('Usage: agentbootup config <set-brain <id> | set-converge <on|off> | set-network-root <path> | show | list-brains>');
  process.exit(1);
}
