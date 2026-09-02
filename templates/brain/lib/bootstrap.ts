/**
 * Agent Identity Bootstrap
 *
 * Self-registers agent with ADMP hub on startup
 * Handles identity, credentials, group membership
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

interface BrainConfig {
  serviceName: string;
  agentId: string;
  type: string;
  role: string;
  capabilities?: string[];
  reportsTo?: string;
  groups?: string[];
  communication: {
    hub: string;
    secretKey?: string;
  };
}

interface AgentIdentity {
  agent_id: string;
  agent_type: string;
  public_key: string;
  secret_key: string;
  webhook_url: string | null;
  capabilities: string[];
  reports_to: string | null;
  groups: string[];
}

/**
 * Bootstrap agent identity
 * Reads config, self-registers with hub, stores credentials
 */
export async function bootstrapAgent(configPath?: string): Promise<AgentIdentity> {
  // 1. Read brain config
  const config = readBrainConfig(configPath);

  console.log(`🧠 Bootstrapping agent: ${config.agentId}`);

  // 2. Check if already registered
  if (config.communication.secretKey) {
    console.log('   Already registered, verifying with hub...');

    const isValid = await verifyRegistration(config);

    if (isValid) {
      console.log('   ✅ Existing registration valid');
      return {
        agent_id: config.agentId,
        agent_type: config.type,
        public_key: '', // Not needed after registration
        secret_key: config.communication.secretKey,
        webhook_url: null,
        capabilities: config.capabilities || [],
        reports_to: config.reportsTo || null,
        groups: config.groups || []
      };
    }

    console.log('   ⚠️  Registration invalid, re-registering...');
  }

  // 3. Register with hub
  console.log('   Registering with ADMP hub...');

  const response = await fetch(`${config.communication.hub}/api/agents/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      agent_id: config.agentId,
      agent_type: config.type,
      metadata: {
        service: config.serviceName,
        role: config.role,
        capabilities: config.capabilities || [],
        reports_to: config.reportsTo,
        version: process.env.npm_package_version || '1.0.0'
      }
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Registration failed: ${error}`);
  }

  const registration = await response.json();

  console.log(`   ✅ Registered as ${registration.agent_id}`);

  // 4. Store secret key in config
  config.communication.secretKey = registration.secret_key;
  saveBrainConfig(config, configPath);

  console.log('   💾 Credentials saved');

  // 5. Join groups
  if (config.groups && config.groups.length > 0) {
    console.log(`   📢 Joining ${config.groups.length} groups...`);

    for (const groupId of config.groups) {
      try {
        await joinGroup(config, groupId);
        console.log(`      ✅ Joined ${groupId}`);
      } catch (error) {
        console.warn(`      ⚠️  Failed to join ${groupId}:`, error);
      }
    }
  }

  // 6. Announce to parent (if configured)
  if (config.reportsTo) {
    console.log(`   📨 Announcing to parent: ${config.reportsTo}`);

    try {
      await announceToParent(config);
      console.log('      ✅ Announcement sent');
    } catch (error) {
      console.warn('      ⚠️  Announcement failed:', error);
    }
  }

  console.log(`✅ Bootstrap complete - ${config.agentId} is online\n`);

  return {
    agent_id: registration.agent_id,
    agent_type: registration.agent_type,
    public_key: registration.public_key,
    secret_key: registration.secret_key,
    webhook_url: registration.webhook_url,
    capabilities: config.capabilities || [],
    reports_to: config.reportsTo || null,
    groups: config.groups || []
  };
}

/**
 * Read brain config from agentbootup.json (canonical source).
 * Falls back to brain/config.json for backward compatibility during transition.
 */
function readBrainConfig(configPath?: string): BrainConfig {
  // If explicit path given, use it directly (test/legacy usage)
  if (configPath) {
    try {
      return JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch (error) {
      throw new Error(`Failed to read brain config from ${configPath}: ${error}`);
    }
  }

  // Canonical source: agentbootup.json in project root
  const projectConfigPath = join(process.cwd(), 'agentbootup.json');
  try {
    const raw = JSON.parse(readFileSync(projectConfigPath, 'utf-8'));
    // Map agentbootup.json fields to BrainConfig shape.
    // Spread raw first so explicit mapped keys win over raw keys.
    const secretKey =
      raw.communication?.secretKey ||
      raw.communication?.secret_key ||
      raw.secret_key ||
      raw.secretKey ||
      '';
    return {
      ...raw,
      serviceName: raw.serviceName || raw.service_name || '',
      agentId: raw.agent_id || raw.agentId,
      type: raw.type,
      role: raw.role,
      capabilities: raw.capabilities || [],
      reportsTo: raw.reports_to || raw.reportsTo,
      groups: raw.groups || [],
      communication: {
        hub: raw.hub || raw.communication?.hub || '',
        secretKey,
      },
    } as BrainConfig;
  } catch {
    // Fallback to brain/config.json for backward compatibility
    const legacyPath = join(process.cwd(), 'brain/config.json');
    try {
      return JSON.parse(readFileSync(legacyPath, 'utf-8'));
    } catch (error) {
      throw new Error(`Failed to read brain config: no agentbootup.json or brain/config.json found in ${process.cwd()}`);
    }
  }
}

/**
 * Save brain config — persist secret_key only into an existing config file (never
 * create agentbootup.json with identity stripped — FR-5 machine-local).
 */
function saveBrainConfig(config: BrainConfig, configPath?: string): void {
  if (!config.communication?.secretKey) return;

  const explicit = configPath;
  const agentbootupPath = join(process.cwd(), 'agentbootup.json');
  const legacyPath = join(process.cwd(), 'brain', 'config.json');
  const target = explicit || (existsSync(agentbootupPath) ? agentbootupPath : legacyPath);

  if (!explicit && !existsSync(agentbootupPath) && !existsSync(legacyPath)) {
    console.warn('bootstrap: skipping secret persist — no agentbootup.json or brain/config.json');
    return;
  }

  try {
    const raw = JSON.parse(readFileSync(target, 'utf-8')) as Record<string, unknown>;
    raw.secret_key = config.communication.secretKey;
    writeFileSync(target, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
  } catch (error) {
    throw new Error(`Failed to save brain config to ${target}: ${error}`);
  }
}

/**
 * Verify existing registration is still valid
 */
async function verifyRegistration(config: BrainConfig): Promise<boolean> {
  try {
    const response = await fetch(
      `${config.communication.hub}/api/agents/${config.agentId}`,
      {
        headers: {
          'X-Agent-ID': config.agentId
        }
      }
    );

    return response.ok;
  } catch (error) {
    return false;
  }
}

/**
 * Join a group
 */
async function joinGroup(config: BrainConfig, groupId: string): Promise<void> {
  const response = await fetch(
    `${config.communication.hub}/api/groups/${groupId}/join`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-ID': config.agentId
      }
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to join group ${groupId}: ${error}`);
  }
}

/**
 * Announce bootup to parent agent
 */
async function announceToParent(config: BrainConfig): Promise<void> {
  if (!config.reportsTo) return;

  const message = {
    from: config.agentId,
    subject: 'Brain Online',
    body: `${config.serviceName} (${config.agentId}) is now online and ready to operate`,
    metadata: {
      type: 'bootup',
      service: config.serviceName,
      role: config.role,
      capabilities: config.capabilities || [],
      version: process.env.npm_package_version || '1.0.0',
      timestamp: new Date().toISOString()
    }
  };

  const response = await fetch(
    `${config.communication.hub}/api/agents/${config.reportsTo}/inbox`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-ID': config.agentId
      },
      body: JSON.stringify(message)
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to announce to parent: ${error}`);
  }
}

/**
 * Example usage:
 *
 * import { bootstrapAgent } from './lib/bootstrap.js';
 *
 * async function main() {
 *   const identity = await bootstrapAgent();
 *   console.log(`I am ${identity.agent_id}`);
 *   console.log(`Capabilities: ${identity.capabilities.join(', ')}`);
 * }
 */
