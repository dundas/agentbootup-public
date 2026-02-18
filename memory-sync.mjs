#!/usr/bin/env node
/**
 * Memory Sync CLI
 *
 * Manage memory synchronization with Mech Storage
 */

import { MemorySyncManager } from './lib/sync/sync-manager.js';
import { SyncConfigManager } from './lib/sync/config-manager.js';
import { DaemonManager } from './lib/daemon/daemon-manager.js';

function printHelp() {
  console.log(`
Memory Sync - Synchronize agent memory across machines

Usage:
  memory-sync <command> [options]

Commands:
  config              Configure sync settings
  push                Push memory to remote storage
  pull                Pull memory from remote storage
  sync                Bidirectional sync (push + pull with conflict resolution)
  watch               Watch for changes and auto-sync
  list                List remote files
  status              Show sync status and configuration
  validate            Validate sync configuration
  daemon              Manage sync daemon

Config Commands:
  config init         Initialize configuration
  config set          Set configuration value
  config get          Get configuration value
  config enable       Enable sync
  config disable      Disable sync

Daemon Commands:
  daemon start        Start daemon in background
  daemon stop         Stop daemon
  daemon status       Show daemon status
  daemon logs         View daemon logs

Options:
  --mech-app-id       Mech Storage app ID
  --mech-api-key      Mech Storage API key
  --mech-url          Mech Storage URL (default: https://storage.mechdna.net)
  --files             Comma-separated file patterns to sync
  --help, -h          Show this help

Examples:
  # Configure sync
  memory-sync config init --mech-app-id=app_xxx --mech-api-key=key_xxx

  # Push memory to remote
  memory-sync push

  # Pull memory from remote
  memory-sync pull

  # Bidirectional sync
  memory-sync sync

  # Watch for changes and auto-sync
  memory-sync watch

  # Sync specific files
  memory-sync sync --files="memory/MEMORY.md,memory/daily/*.md"
`);
}

async function runConfig(args) {
  const configManager = new SyncConfigManager();
  const subcommand = args._[1];

  switch (subcommand) {
    case 'init': {
      const options = {
        mechAppId: args['mech-app-id'],
        mechApiKey: args['mech-api-key'],
        mechUrl: args['mech-url'],
        enabled: true
      };

      const config = await configManager.init(options);
      console.log('✓ Configuration initialized');
      console.log('\nSync config:');
      console.log(`  Provider: ${config.sync.provider}`);
      console.log(`  App ID: ${config.sync.config.appId || '(not set)'}`);
      console.log(`  API Key: ${config.sync.config.apiKey ? '***' : '(not set)'}`);
      console.log(`  Enabled: ${config.sync.enabled}`);
      break;
    }

    case 'enable': {
      await configManager.enable();
      console.log('✓ Sync enabled');
      break;
    }

    case 'disable': {
      await configManager.disable();
      console.log('✓ Sync disabled');
      break;
    }

    case 'get': {
      const config = await configManager.load();
      console.log(JSON.stringify(config, null, 2));
      break;
    }

    case 'set': {
      const key = args._[2];
      const value = args._[3];

      if (!key || !value) {
        console.error('Usage: memory-sync config set <key> <value>');
        process.exit(1);
      }

      const config = await configManager.load();

      // Simple dot-notation setting
      const parts = key.split('.');
      let target = config;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!target[parts[i]]) target[parts[i]] = {};
        target = target[parts[i]];
      }
      target[parts[parts.length - 1]] = value;

      await configManager.save(config);
      console.log(`✓ Set ${key} = ${value}`);
      break;
    }

    default:
      console.error('Unknown config subcommand:', subcommand);
      console.log('Available: init, enable, disable, get, set');
      process.exit(1);
  }
}

async function runPush(args, syncManager) {
  const files = args.files ? args.files.split(',') : undefined;
  await syncManager.push(files);
}

async function runPull(args, syncManager) {
  const files = args.files ? args.files.split(',') : undefined;
  await syncManager.pull(files);
}

async function runSync(args, syncManager) {
  const files = args.files ? args.files.split(',') : undefined;
  await syncManager.sync(files);
}

async function runWatch(args, syncManager) {
  await syncManager.watch();
}

async function runList(args, syncManager) {
  console.log('[Sync] Listing remote files...');
  const files = await syncManager.listRemote();

  if (files.length === 0) {
    console.log('No files in remote storage');
  } else {
    console.log(`\nFound ${files.length} files:\n`);
    for (const file of files) {
      const modified = new Date(file.modified).toISOString();
      const size = (file.size / 1024).toFixed(2);
      console.log(`  ${file.path}`);
      console.log(`    Modified: ${modified}`);
      console.log(`    Size: ${size} KB`);
      console.log(`    Hash: ${file.hash.slice(0, 8)}`);
      console.log('');
    }
  }
}

async function runStatus(args) {
  const configManager = new SyncConfigManager();
  const config = await configManager.load();
  const validation = await configManager.validate();

  console.log('Sync Status:\n');
  console.log(`  Enabled: ${config.sync?.enabled ? '✓' : '✗'}`);
  console.log(`  Provider: ${config.sync?.provider || 'not configured'}`);
  console.log(`  App ID: ${config.sync?.config?.appId || '(not set)'}`);
  console.log(`  API Key: ${config.sync?.config?.apiKey ? '***' : '(not set)'}`);
  console.log(`  Valid: ${validation.valid ? '✓' : '✗'}`);

  if (!validation.valid) {
    console.log('\nErrors:');
    for (const error of validation.errors) {
      console.log(`  - ${error}`);
    }
  }

  console.log('\nFiles to sync:');
  for (const file of config.sync?.files || []) {
    console.log(`  - ${file}`);
  }
}

async function runValidate(args) {
  const configManager = new SyncConfigManager();
  const validation = await configManager.validate();

  if (validation.valid) {
    console.log('✓ Configuration is valid');
  } else {
    console.log('✗ Configuration is invalid');
    console.log('\nErrors:');
    for (const error of validation.errors) {
      console.log(`  - ${error}`);
    }
    process.exit(1);
  }
}

async function runDaemon(args) {
  const daemonManagerOptions = {};
  if (args['daemon-dir']) {
    daemonManagerOptions.daemonDir = args['daemon-dir'];
  }
  if (args['port']) {
    daemonManagerOptions.port = parseInt(args['port'], 10);
  }

  const daemonManager = new DaemonManager(daemonManagerOptions);
  const subcommand = args._[1];
  const basePath = args['base-path'] || process.cwd();

  switch (subcommand) {
    case 'start': {
      try {
        const result = await daemonManager.start(basePath);
        console.log('✓ Daemon started successfully');
        console.log(`  PID: ${result.pid}`);
        console.log(`  Log file: ${result.logFile}`);
      } catch (err) {
        console.error('✗ Failed to start daemon:', err.message);
        process.exit(1);
      }
      break;
    }

    case 'stop': {
      try {
        const result = await daemonManager.stop();

        if (result.alreadyStopped) {
          console.log('Daemon was not running');
        } else if (result.forced) {
          console.log('✓ Daemon stopped (forced)');
        } else {
          console.log('✓ Daemon stopped gracefully');
        }
      } catch (err) {
        console.error('✗ Failed to stop daemon:', err.message);
        process.exit(1);
      }
      break;
    }

    case 'status': {
      try {
        const status = await daemonManager.status();
        console.log(JSON.stringify(status, null, 2));
      } catch (err) {
        console.error('✗ Failed to get status:', err.message);
        process.exit(1);
      }
      break;
    }

    case 'logs': {
      const lines = args.lines ? parseInt(args.lines, 10) : 50;

      try {
        const logs = await daemonManager.logs(lines);
        console.log(logs);
      } catch (err) {
        console.error('✗ Failed to get logs:', err.message);
        process.exit(1);
      }
      break;
    }

    default:
      console.error('Unknown daemon subcommand:', subcommand);
      console.log('Available: start, stop, status, logs');
      process.exit(1);
  }
}

function parseArgs(argv) {
  const args = { _: [] };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg.startsWith('--')) {
      const keyPart = arg.slice(2);

      // Handle --key=value format
      if (keyPart.includes('=')) {
        const [key, ...valueParts] = keyPart.split('=');
        args[key] = valueParts.join('=');
      } else {
        // Handle --key value format
        const value = argv[i + 1];

        if (value && !value.startsWith('--')) {
          args[keyPart] = value;
          i++;
        } else {
          args[keyPart] = true;
        }
      }
    } else {
      args._.push(arg);
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (!command || args.help || args.h) {
    printHelp();
    process.exit(0);
  }

  try {
    if (command === 'config') {
      await runConfig(args);
      return;
    }

    if (command === 'status') {
      await runStatus(args);
      return;
    }

    if (command === 'validate') {
      await runValidate(args);
      return;
    }

    if (command === 'daemon') {
      await runDaemon(args);
      return;
    }

    // All other commands require configured sync
    const configManager = new SyncConfigManager();
    const syncConfig = await configManager.getSyncConfig();
    const syncManager = new MemorySyncManager(syncConfig);

    switch (command) {
      case 'push':
        await runPush(args, syncManager);
        break;
      case 'pull':
        await runPull(args, syncManager);
        break;
      case 'sync':
        await runSync(args, syncManager);
        break;
      case 'watch':
        await runWatch(args, syncManager);
        break;
      case 'list':
        await runList(args, syncManager);
        break;
      default:
        console.error('Unknown command:', command);
        console.log('Run with --help for usage information');
        process.exit(1);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
