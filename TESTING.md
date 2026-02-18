# Testing Guide

This document describes how to test the memory sync daemon and related components.

## Quick Test

Run the automated test suite:

```bash
chmod +x test-daemon.mjs
node test-daemon.mjs
```

Expected output:
```
╔════════════════════════════════════════════════════════════╗
║         Memory Sync Daemon - End-to-End Tests             ║
╚════════════════════════════════════════════════════════════╝

📦 Setting up test environment...
   ✓ Test environment ready

🧪 Test: Daemon Start
   ✅ PASSED (1234ms)

🧪 Test: Health API
   ✅ PASSED (45ms)

...

============================================================
TEST SUMMARY
============================================================

Total: 8
Passed: 8 ✅
Failed: 0 ❌

Total Duration: 12345ms
============================================================
```

## Manual Testing

### Prerequisites

1. Configure sync:
   ```bash
   node memory-sync.mjs config init \
     --mech-app-id=your-app-id \
     --mech-api-key=your-api-key
   ```

2. Ensure memory directory exists:
   ```bash
   mkdir -p memory/daily
   echo "# Test Memory" > memory/MEMORY.md
   ```

### Test 1: Daemon Lifecycle

**Start daemon:**
```bash
node memory-sync.mjs daemon start
```

Expected output:
```
Starting memory sync daemon...
PID: 12345
Log file: ~/.uhr/daemon/memory-sync.log
Daemon started successfully
```

**Check status:**
```bash
node memory-sync.mjs daemon status
```

Expected output:
```json
{
  "running": true,
  "pid": 12345,
  "stats": {
    "syncSuccessCount": 0,
    "syncFailureCount": 0,
    "filesWatched": 5,
    "uptime": 12345,
    ...
  }
}
```

**View logs:**
```bash
node memory-sync.mjs daemon logs
```

Expected output:
```
[Daemon] Starting memory sync daemon...
[Daemon] Performing initial sync...
[Daemon] Watching 3 directories...
[Daemon]   - memory/
[Daemon]   - .ai/protocols/
[Daemon]   - .ai/skills/
[Daemon] ✓ Daemon started successfully
[HTTP] Server listening on http://localhost:8765
[Main] ✓ Daemon running
[Main] Press Ctrl+C to stop
```

**Stop daemon:**
```bash
node memory-sync.mjs daemon stop
```

Expected output:
```
Stopping daemon (PID: 12345)...
Daemon stopped successfully
```

### Test 2: HTTP API

**Start daemon first:**
```bash
node memory-sync.mjs daemon start
```

**Test root endpoint:**
```bash
curl http://localhost:8765/
```

Expected response:
```json
{
  "name": "Memory Sync Daemon",
  "version": "1.0.0",
  "endpoints": {
    "/": "This message",
    "/status": "Daemon status and statistics",
    "/health": "Health check",
    "/sync": "POST - Trigger manual sync",
    "/stop": "POST - Stop daemon gracefully"
  }
}
```

**Test health endpoint:**
```bash
curl http://localhost:8765/health
```

Expected response:
```json
{
  "healthy": true
}
```

**Test status endpoint:**
```bash
curl http://localhost:8765/status
```

Expected response:
```json
{
  "running": true,
  "basePath": "/path/to/project",
  "stats": {
    "syncSuccessCount": 0,
    "syncFailureCount": 0,
    "filesWatched": 5,
    "lastSyncAt": null,
    "startedAt": 1234567890,
    "uptime": 12345,
    "queueLength": 0,
    "watchersCount": 3
  }
}
```

**Test sync endpoint:**
```bash
curl -X POST http://localhost:8765/sync
```

Expected response:
```json
{
  "success": true,
  "message": "Sync triggered successfully"
}
```

**Test stop endpoint:**
```bash
curl -X POST http://localhost:8765/stop
```

Expected response:
```json
{
  "success": true,
  "message": "Daemon stopping..."
}
```

### Test 3: File Watching

**Start daemon with logs visible:**
```bash
node memory-sync.mjs daemon start
tail -f ~/.uhr/daemon/memory-sync.log
```

**In another terminal, modify a file:**
```bash
echo "\n## New Section\n" >> memory/MEMORY.md
```

**Expected log output:**
```
[Daemon] Change detected: memory/MEMORY.md (sync queued)
[Daemon] Syncing memory/MEMORY.md...
[Daemon] ✓ Synced memory/MEMORY.md (pushed)
```

**Check status to verify sync:**
```bash
curl http://localhost:8765/status | jq '.stats.syncSuccessCount'
```

Expected output: `1` (or higher)

### Test 4: Debouncing

**Rapidly modify a file multiple times:**
```bash
for i in {1..5}; do
  echo "Update $i" >> memory/MEMORY.md
  sleep 0.5
done
```

**Check logs:**
```
[Daemon] Change detected: memory/MEMORY.md (sync queued)
[Daemon] Change detected: memory/MEMORY.md (sync queued)
[Daemon] Change detected: memory/MEMORY.md (sync queued)
[Daemon] Change detected: memory/MEMORY.md (sync queued)
[Daemon] Change detected: memory/MEMORY.md (sync queued)
[Daemon] Syncing memory/MEMORY.md...
[Daemon] ✓ Synced memory/MEMORY.md (pushed)
```

**Expected behavior:** Only ONE sync happens after debounce period (2 seconds)

### Test 5: Retry Logic

To test retry logic, you need to simulate a sync failure.

**Option 1: Disconnect network temporarily**

1. Start daemon
2. Disconnect network
3. Modify file
4. Check logs for retries
5. Reconnect network
6. Verify eventual success

**Option 2: Use invalid credentials**

1. Temporarily corrupt `.memory-sync.config.json`
2. Restart daemon
3. Modify file
4. Check logs for retries
5. Fix config
6. Restart daemon

**Expected log output:**
```
[Daemon] Syncing memory/MEMORY.md...
[Daemon] ✗ Sync failed for memory/MEMORY.md: Connection timeout
[Daemon] Retrying in 5000ms (attempt 1/3)
[Daemon] Syncing memory/MEMORY.md...
[Daemon] ✗ Sync failed for memory/MEMORY.md: Connection timeout
[Daemon] Retrying in 5000ms (attempt 2/3)
[Daemon] Syncing memory/MEMORY.md...
[Daemon] ✗ Sync failed for memory/MEMORY.md: Connection timeout
[Daemon] Retrying in 5000ms (attempt 3/3)
[Daemon] Syncing memory/MEMORY.md...
[Daemon] ✗ Sync failed for memory/MEMORY.md: Connection timeout
[Daemon] Max retries reached for memory/MEMORY.md, giving up
```

### Test 6: Hook Integration

**Install Claude Code hooks:**
```bash
cp templates/.claude/hooks/session_start_with_daemon.js.example \
   .claude/hooks/session_start.js

cp templates/.claude/hooks/session_end_with_daemon.js.example \
   .claude/hooks/session_end.js
```

**Start daemon:**
```bash
node memory-sync.mjs daemon start
```

**Start Claude Code:**
```bash
claude
```

**Expected output in Claude session:**
```
[Hook] Starting session with memory sync...
[Hook] ✓ Daemon is running (real-time sync active)
[Hook] Daemon uptime: 45s
[Hook] Files watched: 5
[Hook] ✓ Memory loaded (2.35 KB)
[Hook] ✓ Daily log loaded (2026-02-05)
[Hook] Ready
```

**Exit Claude Code:**
```
[Hook] Session ending (daemon will handle sync)
```

### Test 7: Fallback Mode (No Daemon)

**Stop daemon:**
```bash
node memory-sync.mjs daemon stop
```

**Start Claude Code:**
```bash
claude
```

**Expected output:**
```
[Hook] Starting session with memory sync...
[Hook] ⚠ Daemon not running
[Hook] Attempting fallback sync...
[Hook] ✓ Fallback sync complete
[Hook] ✓ Memory loaded (2.35 KB)
[Hook] Ready
```

**Exit Claude Code:**
```
[Hook] Session ending (no daemon, manual sync recommended)
[Hook] 💡 Tip: Run "node memory-sync.mjs push" to sync your memory
[Hook] Or start the daemon for automatic sync: "node memory-sync.mjs daemon start"
```

### Test 8: Concurrent Sessions

**Start daemon:**
```bash
node memory-sync.mjs daemon start
```

**Open multiple Claude Code sessions:**
```bash
# Terminal 1
claude

# Terminal 2
claude

# Terminal 3
claude
```

**Expected behavior:**
- All sessions start quickly
- All sessions share same daemon
- File changes visible to all sessions
- No conflicts or race conditions

**Modify memory in one session:**
```bash
# In Terminal 1
echo "Update from session 1" >> memory/MEMORY.md
```

**Check daemon logs:**
```
[Daemon] Change detected: memory/MEMORY.md (sync queued)
[Daemon] Syncing memory/MEMORY.md...
[Daemon] ✓ Synced memory/MEMORY.md (pushed)
```

**Verify all sessions have access to updated memory** (via daemon sync)

### Test 9: Graceful Shutdown

**Start daemon:**
```bash
node memory-sync.mjs daemon start
```

**Modify files without waiting for sync:**
```bash
echo "Quick update 1" >> memory/MEMORY.md
echo "Quick update 2" >> memory/MEMORY.md
echo "Quick update 3" >> memory/MEMORY.md
```

**Immediately stop daemon:**
```bash
node memory-sync.mjs daemon stop
```

**Expected behavior:**
- Daemon performs final sync before exiting
- All pending changes are synced
- No data loss

**Check logs:**
```
[Daemon] Stopping daemon...
[Daemon] Performing final sync...
[Daemon] ✓ Synced memory/MEMORY.md (pushed)
[Daemon] ✓ Daemon stopped
```

### Test 10: Stress Test

**Create many files:**
```bash
for i in {1..20}; do
  echo "# Log $i" > memory/daily/2026-02-$(printf "%02d" $i).md
done
```

**Start daemon and watch performance:**
```bash
node memory-sync.mjs daemon start

# Monitor stats
watch -n 1 'curl -s http://localhost:8765/status | jq ".stats"'
```

**Rapidly modify files:**
```bash
for i in {1..50}; do
  echo "Update $i" >> memory/MEMORY.md
  sleep 0.1
done
```

**Expected behavior:**
- Daemon handles load gracefully
- Debouncing reduces sync count
- No crashes or errors
- Memory usage stable

## Performance Benchmarks

### Target Metrics

| Metric | Target | Measured |
|--------|--------|----------|
| Daemon startup | < 2s | |
| Session start (with daemon) | < 200ms | |
| Session start (no daemon) | < 5s | |
| File change detection | < 100ms | |
| Sync operation | < 1s | |
| Daemon memory usage | < 50MB | |
| Daemon CPU usage (idle) | < 1% | |

### Measuring Performance

**Daemon startup time:**
```bash
time node memory-sync.mjs daemon start
```

**Session start time (with daemon):**
```bash
node memory-sync.mjs daemon start
time node -e "require('./.claude/hooks/session_start.js').onSessionStart()"
```

**Session start time (no daemon):**
```bash
node memory-sync.mjs daemon stop
time node -e "require('./.claude/hooks/session_start.js').onSessionStart()"
```

**Daemon resource usage:**
```bash
# Get PID
PID=$(node memory-sync.mjs daemon status | jq -r '.pid')

# Monitor resources
ps aux | grep $PID
top -pid $PID
```

## Troubleshooting Tests

### Daemon won't start

**Check port availability:**
```bash
lsof -i :8765
```

**Check logs for errors:**
```bash
cat ~/.uhr/daemon/memory-sync.log
```

**Verify config:**
```bash
cat .memory-sync.config.json
node memory-sync.mjs config validate
```

### Tests timing out

**Increase timeouts in test-daemon.mjs:**
```javascript
const TEST_TIMEOUT = 120000; // 2 minutes
```

**Check system resources:**
```bash
top
df -h
```

### Sync failures

**Test Mech Storage credentials:**
```bash
node memory-sync.mjs list
node memory-sync.mjs sync
```

**Check network connectivity:**
```bash
ping storage.mechdna.net
```

**Try local provider for testing:**
```json
{
  "provider": "local",
  "files": ["memory/**/*.md"]
}
```

## CI/CD Integration

### GitHub Actions

```yaml
name: Test Daemon

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v2

      - name: Setup Node.js
        uses: actions/setup-node@v2
        with:
          node-version: '18'

      - name: Install dependencies
        run: npm install

      - name: Run daemon tests
        run: node test-daemon.mjs

      - name: Upload logs on failure
        if: failure()
        uses: actions/upload-artifact@v2
        with:
          name: daemon-logs
          path: ~/.uhr/daemon/memory-sync.log
```

## Reporting Issues

When reporting daemon issues, include:

1. **Daemon status:**
   ```bash
   node memory-sync.mjs daemon status
   ```

2. **Daemon logs:**
   ```bash
   node memory-sync.mjs daemon logs
   ```

3. **Config (redacted):**
   ```bash
   cat .memory-sync.config.json | jq 'del(.mech.apiKey)'
   ```

4. **System info:**
   ```bash
   node --version
   uname -a
   ```

5. **Test results:**
   ```bash
   node test-daemon.mjs
   ```
