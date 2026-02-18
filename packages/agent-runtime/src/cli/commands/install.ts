/**
 * agent install — Install the agent service config without starting it
 *
 * Creates the platform-native service configuration (plist/unit/pm2 config)
 * from the agent.config.ts in the current directory.
 */

import { loadConfig, toAgentStartConfig } from '../../config';
import { getProcessManager, getPlatform } from '../../platform';

export async function cmdInstall() {
  const config = await loadConfig();
  const startConfig = toAgentStartConfig(config);
  const manager = await getProcessManager();
  const platform = getPlatform();

  await manager.install(startConfig);

  console.log(`${config.name} installed (${platform})`);
  console.log(`  Run "agent start" to start the service.`);
}
