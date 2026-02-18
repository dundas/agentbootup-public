# Session Hooks with Daemon Integration

This directory contains session hooks for Claude Code and Gemini CLI that integrate with the memory sync daemon.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Session Hooks                      │
│  (.claude/hooks/ or .gemini/hooks/)                 │
└───────────────────┬─────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────┐
│           Daemon Helper Library                     │
│         (lib/hooks/daemon-helper.js)                │
│                                                      │
│  • isDaemonRunning() - Check daemon health          │
│  • handleSessionStart() - Smart startup             │
│  • handleSessionEnd() - Graceful shutdown           │
│  • fallbackSync() - Manual sync when no daemon     │
└───────────────────┬─────────────────────────────────┘
                    │
        ┌───────────┴───────────┐
        │                       │
        ▼                       ▼
┌──────────────┐      ┌──────────────────┐
│   Daemon     │      │  Fallback Sync   │
│  (port 8765) │      │  (CLI command)   │
└──────────────┘      └──────────────────┘
```

## How It Works

### Fast Path (Daemon Running)
1. Hook checks daemon health via HTTP
2. Daemon is running → Instant memory load
3. No sync needed (daemon handles real-time)
4. Session starts immediately

### Fallback Path (No Daemon)
1. Hook checks daemon health
2. Daemon not running → Trigger one-time sync
3. Sync pulls latest from remote
4. Load memory from disk
5. Session starts (slower, but works)

## Setup

### 1. Configure Memory Sync

First, configure your Mech Storage credentials:

```bash
cd /path/to/your/project
node memory-sync.mjs config init \
  --mech-app-id=your-app-id \
  --mech-api-key=your-api-key
```

This creates `.memory-sync.config.json` with your sync settings.

### 2. Install Hooks

#### For Claude Code

```bash
# Copy hook templates
cp templates/.claude/hooks/session_start_with_daemon.js.example \
   .claude/hooks/session_start.js

cp templates/.claude/hooks/session_end_with_daemon.js.example \
   .claude/hooks/session_end.js

# Restart Claude Code to activate hooks
```

#### For Gemini CLI

```bash
# Copy hook templates
cp templates/.gemini/hooks/on_start_with_sync.js.example \
   .gemini/hooks/on_start.js

cp templates/.gemini/hooks/on_end_with_daemon.js.example \
   .gemini/hooks/on_end.js

# Restart Gemini CLI to activate hooks
```

### 3. Start the Daemon (Optional but Recommended)

For real-time sync and instant startup:

```bash
# Start daemon in background
node memory-sync.mjs daemon start

# Check daemon status
node memory-sync.mjs daemon status

# View daemon logs
node memory-sync.mjs daemon logs

# Stop daemon
node memory-sync.mjs daemon stop
```

## Usage

### With Daemon (Recommended)

```bash
# Start daemon once
node memory-sync.mjs daemon start

# Now all sessions start instantly
claude                    # Fast startup, real-time sync
gemini                    # Fast startup, real-time sync

# Daemon continues running in background
# Your memory syncs automatically as you work
```

### Without Daemon (Fallback)

```bash
# Sessions work but slower
claude                    # Syncs once on startup
gemini                    # Syncs once on startup

# Manual sync at end of session
node memory-sync.mjs push
```

## Hook Behavior

### Session Start Hook

| Daemon Status | Behavior |
|---------------|----------|
| Running ✅ | Instant load, daemon handles sync |
| Not Running ❌ | One-time pull sync, then load |

### Session End Hook

| Daemon Status | Behavior |
|---------------|----------|
| Running ✅ | No action (daemon synced already) |
| Not Running ❌ | Reminder to run manual sync |

## API Reference

### Daemon Helper Library

Located at: `lib/hooks/daemon-helper.js`

#### `handleSessionStart(options)`

Smart session startup with daemon integration.

**Options:**
- `basePath` (string) - Project root directory (default: `process.cwd()`)
- `daemonPort` (number) - Daemon HTTP port (default: `8765`)
- `daemonHost` (string) - Daemon host (default: `'localhost'`)
- `useFallback` (boolean) - Use fallback sync if no daemon (default: `true`)
- `verbose` (boolean) - Verbose logging (default: `true`)

**Returns:**
```javascript
{
  daemonRunning: boolean,
  memory: string,
  dailyLog: string,
  memoryPath: string,
  dailyLogPath: string
}
```

#### `handleSessionEnd(options)`

Graceful session shutdown.

**Options:**
- `daemonPort` (number) - Daemon HTTP port (default: `8765`)
- `daemonHost` (string) - Daemon host (default: `'localhost'`)
- `verbose` (boolean) - Verbose logging (default: `true`)

**Returns:**
```javascript
{
  daemonHandled: boolean
}
```

#### `isDaemonRunning(port, host)`

Check if daemon is running and healthy.

**Returns:** `Promise<boolean>`

#### `getDaemonStatus(port, host)`

Get daemon status and statistics.

**Returns:** `Promise<object | null>`

#### `triggerDaemonSync(port, host)`

Manually trigger daemon sync.

**Returns:** `Promise<object>`

#### `fallbackSync(basePath)`

Fallback sync using CLI (when daemon not running).

**Returns:** `Promise<{ success: boolean, output?: string, error?: string }>`

## Troubleshooting

### Hook not running?

Check that the hook file:
1. Has correct name (no `.example` suffix)
2. Is executable (if needed by CLI)
3. Uses correct `require()` path to daemon-helper

### Daemon not starting?

```bash
# Check if port 8765 is in use
lsof -i :8765

# View daemon logs
node memory-sync.mjs daemon logs

# Check daemon status
node memory-sync.mjs daemon status
```

### Sync failing?

```bash
# Test sync manually
node memory-sync.mjs sync

# Check config
cat .memory-sync.config.json

# Verify Mech credentials
node memory-sync.mjs config validate
```

## Development

### Creating Custom Hooks

You can create your own hooks using the daemon helper:

```javascript
const { handleSessionStart, isDaemonRunning } = require('./lib/hooks/daemon-helper.js');

async function myCustomHook() {
  // Check daemon status
  const isRunning = await isDaemonRunning();
  console.log('Daemon running:', isRunning);

  // Load memory
  const result = await handleSessionStart({
    basePath: process.cwd(),
    verbose: true
  });

  // Use result.memory and result.dailyLog
  console.log('Memory size:', result.memory.length);

  return result;
}
```

### Testing Hooks

```bash
# Test hook directly
node -e "require('./.claude/hooks/session_start.js').onSessionStart().then(console.log)"

# Test with daemon running
node memory-sync.mjs daemon start
node -e "require('./.claude/hooks/session_start.js').onSessionStart().then(console.log)"
node memory-sync.mjs daemon stop
```

## Performance

### With Daemon
- **Startup time**: < 100ms (memory load only)
- **Sync latency**: Real-time (2 second debounce)
- **Memory overhead**: ~10MB (daemon process)

### Without Daemon
- **Startup time**: 2-5 seconds (includes sync)
- **Sync latency**: Manual (on demand)
- **Memory overhead**: None (no background process)

## Best Practices

1. **Run daemon for active projects** - Start daemon for projects you work on daily
2. **Skip daemon for occasional use** - Fallback mode works fine for occasional sessions
3. **Monitor daemon logs** - Check logs if sync seems slow or stuck
4. **Restart daemon after config changes** - Stop and start daemon if you change sync settings
5. **Use manual sync as backup** - Always available via `memory-sync.mjs push/pull`

## See Also

- [Memory Sync CLI Documentation](./MEMORY_SYNC_CLI.md)
- [Daemon Architecture](./DAEMON_ARCHITECTURE.md)
- [Mech Storage Integration](./MECH_STORAGE.md)
