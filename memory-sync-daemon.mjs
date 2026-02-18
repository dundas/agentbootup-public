#!/usr/bin/env node
/**
 * Memory Sync Daemon Entry Point
 *
 * Runs the memory sync daemon process
 */

import { MemorySyncDaemon } from './lib/daemon/memory-sync-daemon.js';
import { DaemonHttpServer } from './lib/daemon/http-server.js';

function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base-path' && argv[i + 1]) {
      args.basePath = argv[++i];
    } else if (argv[i] === '--port' && argv[i + 1]) {
      args.port = parseInt(argv[++i], 10);
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(`
Memory Sync Daemon

Usage:
  memory-sync-daemon.mjs [options]

Options:
  --base-path <path>    Project base path (default: current directory)
  --port <number>       HTTP API port (default: 8765)
  --help, -h            Show this help

The daemon runs in the foreground. Use the daemon manager to run in background:
  node memory-sync.mjs daemon start
`);
      process.exit(0);
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log('='.repeat(60));
  console.log('Memory Sync Daemon');
  console.log('='.repeat(60));
  console.log(`PID: ${process.pid}`);
  console.log(`Base path: ${args.basePath || process.cwd()}`);
  console.log(`HTTP port: ${args.port || 8765}`);
  console.log('');

  // Create daemon
  const daemon = new MemorySyncDaemon({
    basePath: args.basePath
  });

  // Create HTTP server
  const httpServer = new DaemonHttpServer(daemon, {
    port: args.port,
    apiToken: process.env.DAEMON_API_TOKEN,
    requireAuth: true
  });

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\n[Main] Received ${signal}, shutting down...`);

    try {
      await daemon.stop();
      await httpServer.stop();
      console.log('[Main] Shutdown complete');
      process.exit(0);
    } catch (err) {
      console.error('[Main] Shutdown error:', err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Start daemon
  try {
    await daemon.start();
    await httpServer.start();

    console.log('[Main] ✓ Daemon running');
    console.log('[Main] Press Ctrl+C to stop');
  } catch (err) {
    console.error('[Main] Failed to start:', err.message);
    process.exit(1);
  }
}

main();
