# Universal Hook Registry (UHR) Compatibility

This package is designed to be compatible with the Universal Hook Registry (UHR) specification, a future system for managing hooks across different AI coding assistants.

## What is UHR?

The Universal Hook Registry (UHR) is a proposed standard for:
- **Hook discovery** - Find available hooks in a project
- **Hook management** - Enable/disable/configure hooks
- **Cross-CLI compatibility** - Same hooks work with different tools
- **Version management** - Handle hook updates and dependencies
- **Service coordination** - Manage background services (daemons)

## Our UHR Manifest

Location: `.ai/hooks.manifest.json`

This file describes:
- Available hooks (session.start, session.end)
- Service definitions (memory-sync-daemon)
- CLI commands and options
- Configuration schema
- Installation steps
- Compatibility information

## Current Status

### UHR Compatibility: ✅ Ready

Our hooks are **UHR-compatible by design**:

1. **CLI-Agnostic Core** - Generic helper library works with any CLI
2. **Structured Manifest** - Complete metadata for hook discovery
3. **Service Management** - Daemon lifecycle documented
4. **Standard Patterns** - Follows hook lifecycle conventions
5. **Future-Proof** - Can be registered with UHR when available

### What Works Now (Without UHR)

```
┌─────────────────────────────────────┐
│         Current Architecture        │
├─────────────────────────────────────┤
│                                     │
│  .claude/hooks/                     │
│    └─ session_start.js              │
│    └─ session_end.js                │
│                                     │
│  .gemini/hooks/                     │
│    └─ on_start.js                   │
│    └─ on_end.js                     │
│                                     │
│  lib/hooks/                         │
│    └─ daemon-helper.js (shared)     │
│                                     │
│  memory-sync-daemon (service)       │
│                                     │
└─────────────────────────────────────┘

✅ Hooks work independently
✅ Daemon runs standalone
✅ CLI-specific conventions respected
```

### What UHR Will Enable (Future)

```
┌─────────────────────────────────────┐
│      Future UHR Architecture        │
├─────────────────────────────────────┤
│                                     │
│  UHR Registry                       │
│    ├─ Discovers hooks via manifest  │
│    ├─ Manages service lifecycle     │
│    ├─ Handles updates/versions      │
│    └─ Cross-CLI coordination        │
│                                     │
│  Our Hooks (no changes needed)      │
│    ├─ Auto-discovered               │
│    ├─ Centrally managed             │
│    ├─ Version controlled            │
│    └─ Service auto-started          │
│                                     │
└─────────────────────────────────────┘

🔮 Automatic discovery
🔮 Central management UI
🔮 One-click enable/disable
🔮 Automatic updates
🔮 Service health monitoring
```

## How We're UHR-Ready

### 1. Standardized Manifest

Our `hooks.manifest.json` follows UHR conventions:

```json
{
  "hooks": {
    "session.start": { ... },
    "session.end": { ... }
  },
  "services": {
    "daemon": { ... }
  },
  "cli": {
    "commands": { ... }
  }
}
```

This allows UHR to:
- Discover our hooks
- Understand dependencies
- Manage lifecycle
- Show documentation

### 2. Generic Core

`lib/hooks/daemon-helper.js` is CLI-agnostic:
- No Claude-specific code
- No Gemini-specific code
- Pure JavaScript
- Standard Node.js APIs

This allows:
- Easy UHR integration
- Support for new CLIs
- Testing without CLI

### 3. Service Metadata

Daemon fully described in manifest:

```json
{
  "services": {
    "daemon": {
      "executable": "memory-sync-daemon.mjs",
      "port": 8765,
      "api": { ... },
      "lifecycle": { ... }
    }
  }
}
```

This allows UHR to:
- Start/stop daemon automatically
- Monitor daemon health
- Restart on failure
- Show status in UI

### 4. Adapter Pattern

Each CLI has thin adapter:

```
┌──────────────────┐
│  Claude Adapter  │  ← Claude-specific conventions
├──────────────────┤
│                  │
│  Generic Core    │  ← Reusable logic
│                  │
├──────────────────┤
│  Gemini Adapter  │  ← Gemini-specific conventions
└──────────────────┘
```

Benefits:
- Easy to add new CLIs
- Core logic shared
- Adapters are simple
- UHR can inject adapters

## Migration Path

### Phase 1: Current (Manual Setup) ✅

```bash
# User manually copies hooks
cp templates/.claude/hooks/*.js .claude/hooks/

# User manually configures
node memory-sync.mjs config init

# User manually starts daemon
node memory-sync.mjs daemon start
```

### Phase 2: With UHR (Future) 🔮

```bash
# UHR discovers via manifest
uhr discover

# UHR shows available hooks
uhr list

# One command to enable
uhr enable memory-sync-hooks

# UHR handles everything:
# - Copies hooks to right locations
# - Prompts for config
# - Starts daemon
# - Monitors health
```

## Testing UHR Compatibility

### Manual Validation

```bash
# 1. Validate manifest schema
cat .ai/hooks.manifest.json | jq '.'

# 2. Test hook discovery
find . -name "*.manifest.json"

# 3. Test service API
curl http://localhost:8765/health
curl http://localhost:8765/status

# 4. Test lifecycle
node memory-sync.mjs daemon start
node memory-sync.mjs daemon status
node memory-sync.mjs daemon stop
```

### Automated Tests (Future)

```bash
# When UHR is available
uhr validate hooks.manifest.json
uhr test memory-sync-hooks
uhr simulate session.start
```

## For UHR Developers

If you're building UHR, here's what our hooks need:

### Required UHR Features

1. **Manifest Discovery**
   - Scan for `*.manifest.json` in `.ai/` directories
   - Parse hook definitions
   - Extract service metadata

2. **Hook Registration**
   - Copy templates to CLI-specific directories
   - Preserve exports and function names
   - Handle `.example` suffixes

3. **Service Management**
   - Start/stop daemon via CLI commands
   - Monitor health via HTTP endpoints
   - Display logs and status

4. **Configuration**
   - Prompt for required config values
   - Validate credentials
   - Store securely

### Optional UHR Features

1. **Update Management**
   - Check for hook updates
   - Show changelog
   - Auto-update with user consent

2. **Health Monitoring**
   - Dashboard showing hook status
   - Service health checks
   - Error notifications

3. **Cross-Project Sync**
   - Share hooks across projects
   - Global enable/disable
   - Sync preferences

## Contributing

### Adding New CLI Support

To add support for a new CLI:

1. **Create adapter**
   ```javascript
   // templates/.newcli/hooks/session_start.js
   const { handleSessionStart } = require('../../lib/hooks/daemon-helper.js');

   async function onSessionStart() {
     return await handleSessionStart({ verbose: true });
   }

   module.exports = { onSessionStart };
   ```

2. **Update manifest**
   ```json
   {
     "hooks": {
       "session.start": {
         "implementations": {
           "newcli": {
             "file": "../.newcli/hooks/session_start.js",
             "export": "onSessionStart",
             "enabled": false
           }
         }
       }
     }
   }
   ```

3. **Test integration**
   ```bash
   # Start daemon
   node memory-sync.mjs daemon start

   # Test new CLI
   newcli --hooks-enabled
   ```

### Updating Manifest

When adding features:

1. Document in `hooks.manifest.json`
2. Update version number
3. Add to changelog
4. Test with existing CLIs

## Resources

- **Manifest**: `.ai/hooks.manifest.json`
- **Hooks README**: `templates/HOOKS_README.md`
- **Daemon Architecture**: Implementation docs
- **UHR Specification**: (when available)

## Questions?

- **How do I use this now?** See `templates/HOOKS_README.md`
- **When will UHR be available?** Unknown, designed to work with or without it
- **Will my setup break?** No, UHR will be opt-in enhancement
- **Can I build UHR?** Yes! Use our manifest as reference

---

**Status**: UHR-ready, works standalone
**Last Updated**: 2026-02-05
