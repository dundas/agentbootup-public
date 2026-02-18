
# Transcript Analysis Module

Autonomous transcript analysis and insight extraction for self-improvement.

## Overview

This module automatically analyzes Claude Code session transcripts and extracts:
- **Technical learnings** - New APIs, patterns, techniques
- **Skills developed** - New capabilities built
- **Mistakes & corrections** - Errors made and lessons learned
- **Strategic decisions** - Important choices and rationale
- **Patterns** - Recurring issues or successful approaches

Extracted insights are written to memory files for long-term knowledge building.

## Architecture

```
┌─────────────────────────────────────────────────┐
│          Transcript Analyzer                    │
├─────────────────────────────────────────────────┤
│                                                  │
│  1. TranscriptParser                            │
│     └─> Parses .jsonl transcripts               │
│         Extracts messages, tools, files, errors │
│         Built-in caching for performance        │
│                                                  │
│  2. InsightExtractor                             │
│     └─> LLM-powered analysis                    │
│         Extracts structured insights            │
│         Filters for significance                │
│                                                  │
│  3. MemoryWriter                                 │
│     └─> Formats insights                        │
│         Writes to memory/daily/*.md             │
│         Updates memory/MEMORY.md (curated)      │
│                                                  │
│  4. TranscriptAnalyzer (Orchestrator)            │
│     └─> Watches for new transcripts             │
│         Runs periodic analysis                  │
│         Tracks processed sessions               │
│                                                  │
└─────────────────────────────────────────────────┘
                     │
                     ▼
            ┌────────────────┐
            │ Memory Files   │
            │ - daily/*.md   │
            │ - MEMORY.md    │
            └────────────────┘
                     │
                     ▼
         ┌───────────────────────┐
         │ Memory Sync Daemon    │
         │ → Mech Storage        │
         └───────────────────────┘
```

## Components

### TranscriptParser
Parses Claude Code `.jsonl` transcripts from `~/.claude/projects/`:
- Extracts messages, tool uses, files modified, errors
- Generates session summary (duration, message count, etc.)
- Built-in caching for repeat queries
- Extracts key topics from conversation

### InsightExtractor
Uses LLM to analyze session and extract insights:
- Builds context summary for LLM
- Structured JSON extraction
- Filters for significant insights only
- Graceful fallback on parsing errors

### MemoryWriter
Formats and writes insights to memory files:
- **daily/YYYY-MM-DD.md** - Daily session logs (all analyzed sessions)
- **MEMORY.md** - Curated long-term learnings (significant only)
- Prevents duplicate entries
- Creates structured, readable format

### TranscriptAnalyzer
Orchestrates the full analysis pipeline:
- Watches for new/recent transcripts
- Runs analysis on schedule (default: 1 hour)
- Tracks processed sessions (no duplicates)
- Event-driven architecture
- Persistent state across restarts

## Usage

### Programmatic

```javascript
import { TranscriptAnalyzer } from './lib/analysis/transcript-analyzer.js';
import { MechLLMsClient } from './lib/analysis/mech-llms-client.js';

// Create LLM client
const llmClient = new MechLLMsClient({
  appId: process.env.MECH_APP_ID,
  apiKey: process.env.MECH_API_KEY
});

// Create analyzer
const analyzer = new TranscriptAnalyzer({
  basePath: process.cwd(),        // Where memory/ dir lives
  projectPath: process.cwd(),     // Project to analyze
  llmClient,
  checkIntervalMs: 60 * 60 * 1000 // Check every hour
});

// Listen to events
analyzer.on('session:analyzed', (data) => {
  console.log(`Analyzed: ${data.sessionId}`);
  console.log(`Insights: ${data.insightsCount}`);
});

// Start
await analyzer.start();

// Later: stop
await analyzer.stop();
```

### CLI Testing

```bash
# Set up environment
export MECH_APP_ID=your_app_id
export MECH_API_KEY=your_api_key
export PROJECT_PATH=/path/to/project
export BASE_PATH=/path/to/memory/dir

# Run test
node test-transcript-analyzer.mjs
```

## Configuration

### TranscriptAnalyzer Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `basePath` | string | `process.cwd()` | Where memory/ directory lives |
| `projectPath` | string | `basePath` | Project to analyze transcripts for |
| `llmClient` | object | **required** | Mech LLMs API client |
| `checkIntervalMs` | number | `3600000` | How often to check for new sessions (ms) |

### MechLLMsClient Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `appId` | string | **required** | Mech app ID |
| `apiKey` | string | **required** | Mech API key |
| `mechUrl` | string | `https://llms.mechdna.net` | Mech LLMs API URL |

## Events

The `TranscriptAnalyzer` emits the following events:

- `started` - Analyzer started
- `stopped` - Analyzer stopped
- `session:analyzed` - Session successfully analyzed
  - `{ sessionId, insightsCount, dailyLogPath, memoryPath }`
- `session:error` - Error analyzing session
  - `{ sessionId, error }`
- `analysis:complete` - Batch analysis complete
  - `{ sessionsAnalyzed }`
- `error` - General error

## Output Format

### Daily Log (`memory/daily/YYYY-MM-DD.md`)

```markdown
# Daily Log: 2026-02-05

> Autonomous session analysis and learnings

## Session c5fc2201 (14:30)

**Summary:** Built transcript query skill with fuzzy search
**Duration:** 2h 15m
**Location:** `/Users/kefentse/dev_env/decisive_redux`
**Branch:** `feat/transcript-query`
**Activity:** 120 messages, 8 files modified

### Technical Learnings
- Levenshtein distance algorithm for fuzzy string matching
- Simple stemming via suffix removal (ing, ed, s)
- Relevance scoring: combine exact, fuzzy, stemmed, partial matches

### Skills Developed
- transcript-query skill with intelligent search
- Performance caching with mtime validation

### Patterns
- Caching parsed data gives infinite speedup on repeat queries
- Fuzzy search catches common typos (edit distance ≤ 2)
```

### Memory.md (Curated)

Only significant learnings are added to MEMORY.md:
- Mentions "never", "always", "critical", "important"
- Contains specific patterns or anti-patterns
- Substantial insights (>50 characters)

## Integration with Memory Sync

The TranscriptAnalyzer writes to memory files, which the Memory Sync Daemon then syncs to Mech Storage:

1. Analyzer writes to `memory/daily/YYYY-MM-DD.md`
2. File watcher detects change
3. Memory Sync Daemon syncs to Mech Storage
4. Other instances can pull the insights

## State Management

The analyzer maintains state in `.transcript-analyzer-state.json`:
- `processedSessions` - Array of session IDs already analyzed
- `stats` - Analysis statistics
- `lastSaved` - When state was last saved

State is:
- Loaded on start
- Saved on stop
- Prevents duplicate analysis
- Survives restarts

## Performance

- **Caching:** Parsed transcripts cached by path + mtime
- **Incremental:** Only analyzes new/unprocessed sessions
- **Significance filter:** Skips trivial sessions (< 10 messages, no files, < 5min)
- **Batch processing:** Analyzes multiple sessions in one run

## Future Enhancements

- [ ] Real-time transcript watching (detect new .jsonl immediately)
- [ ] Semantic similarity search (find related past work)
- [ ] Pattern detection across sessions (recurring issues)
- [ ] Skill extraction suggestions (formalize new capabilities)
- [ ] Decision timeline (track why we made choices)
- [ ] Integration with process manager for daemon mode

## Security

- LLM API keys stored in environment variables
- No sensitive data logged
- Session IDs truncated in logs (first 8 chars)
- State file is local-only (not synced)

## Testing

```bash
# Unit test components
bun test lib/analysis/

# Integration test
MECH_APP_ID=xxx MECH_API_KEY=yyy node test-transcript-analyzer.mjs

# Test on specific project
PROJECT_PATH=/path/to/project node test-transcript-analyzer.mjs
```

## Troubleshooting

**"No transcripts found"**
- Check PROJECT_PATH is absolute
- Verify `~/.claude/projects/<normalized-path>/` exists
- Path normalization: `/` → `-`

**"Session not significant, skipping"**
- Session < 10 messages
- No files modified
- Duration < 5 minutes
- No errors encountered
- This is normal for trivial sessions

**"Failed to parse LLM response"**
- LLM didn't return valid JSON
- Falls back to empty insights
- Check LLM prompt/temperature

**High memory usage**
- Parser caches all parsed transcripts
- Clear cache: restart analyzer
- Or: implement cache size limit

## License

Part of agentbootup autonomous agent system.
