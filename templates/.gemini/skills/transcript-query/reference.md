# Transcript Query - Reference Guide

## Quick Start

Gemini CLI saves session transcripts to:
```
~/.gemini/projects/<project-path>/<session-id>.jsonl
```

Where `<project-path>` is the normalized absolute path (slashes replaced with dashes).

Example:
- Project: `/Users/kefentse/dev_env/decisive_redux`
- Transcript directory: `~/.gemini/projects/-Users-kefentse-dev-env-decisive-redux/`

## CLI Usage

```bash
# From within your project
cd /Users/kefentse/dev_env/myproject

# Show most recent session
node transcript-query.mjs recent

# Search recent sessions (default: last 10)
node transcript-query.mjs search "authentication"

# Search ALL sessions
node transcript-query.mjs search "infinitrade" --all

# Search last N sessions (e.g., last 20)
node transcript-query.mjs search "daemon" --recent 20

# Search specific session
node transcript-query.mjs search "error" --session c5fc2201

# Find what you were working on before a topic
node transcript-query.mjs before "refactoring"

# List all sessions
node transcript-query.mjs list

# Show detailed summary of a session
node transcript-query.mjs summary <session-id>
```

## Search Options

| Option | Description | Example |
|--------|-------------|---------|
| (default) | Search last 10 sessions | `search "auth"` |
| `--all` | Search all sessions | `search "auth" --all` |
| `--recent N` | Search last N sessions | `search "auth" --recent 20` |
| `--session ID` | Search specific session | `search "auth" --session c5fc2201` |

**Performance:** Parsed transcripts are cached automatically. Second search is instant (∞x speedup).

## Programmatic Usage

```javascript
import { TranscriptParser } from './lib/transcript-parser.js';

const parser = new TranscriptParser();

// Get recent session
const recent = await parser.getMostRecentTranscript(process.cwd());
const data = await parser.parseTranscript(recent.path);

console.log(`Last session: ${data.summary.durationFormatted}`);
console.log(`Files modified: ${data.summary.filesModifiedCount}`);

// Search with fuzzy matching and options
const matches = parser.searchMessages(data, 'infinitrade', {
  fuzzyThreshold: 2,      // Max edit distance for typos
  includePartial: true,   // Include substring matches
  includeStemmed: true,   // Include stemmed variations
  minScore: 0.3          // Minimum relevance score
});

// Results include score and match details
matches.forEach(m => {
  console.log(`Score: ${m.score.toFixed(2)}`);
  console.log(`Match types: ${m.matches.map(mt => mt.type).join(', ')}`);
  console.log(`Content: ${m.content.substring(0, 100)}...`);
});
```

## Integration with Claude

When I (Claude) need to answer "what were we working on before X?", I can:

```javascript
import { TranscriptParser } from './.gemini/skills/transcript-query/lib/transcript-parser.js';

const parser = new TranscriptParser();

// User asks: "what were we working on before the daemon?"
const result = await parser.findWorkBefore(
  process.cwd(),
  'daemon'
);

if (result.found) {
  // I can now tell the user about previous work
  const summary = result.previousSessions.map(s =>
    `- ${new Date(s.startTime).toLocaleDateString()}: ${s.keyTopics.slice(0,3).join(', ')}`
  ).join('\n');

  return `Before working on the daemon, we were working on:\n${summary}`;
}
```

## Example: Answering Context Questions

**User**: "What were we working on before we started the memory sync daemon?"

**Claude's internal process**:
1. Parse question to extract key term: "memory sync daemon"
2. Use `findWorkBefore()` to search transcripts
3. Extract previous sessions before that topic
4. Summarize previous work from key topics and file changes
5. Present to user

**Response**:
```
Before working on the memory sync daemon, we were working on:

1. ADMP Groups Extension (Feb 4)
   - Hub implementation with 12 group endpoints
   - Access control and message history
   - 8 files modified

2. Derivative Admin MVP (Feb 3)
   - Environment variable authentication
   - PR #3 merged
   - 5 files modified
```

## Key Features

### 1. Timeline Reconstruction
See exactly what happened in a session:
```bash
node transcript-query.mjs summary c5fc2201-871d-4a4b-9798-169f52d38ec5
```

### 2. Keyword Search (with Fuzzy Matching)
Find all mentions of a topic with intelligent matching:
```bash
node transcript-query.mjs search "authentication"
node transcript-query.mjs search "inifitrade"  # Finds "infinitrade" via fuzzy match
node transcript-query.mjs search "trade"       # Finds "trading", "infinitrade" via stemming
```

**Search features:**
- **Exact match**: Highest priority, exact keyword match
- **Fuzzy match**: Catches typos (e.g., "inifitrade" → "infinitrade")
- **Stemming**: Finds word variations (e.g., "trade" finds "trading", "traded")
- **Partial match**: Substring matching (e.g., "auth" finds "authentication")
- **Relevance scoring**: Results ranked by match quality

### 3. Context Discovery
Find what came before:
```bash
node transcript-query.mjs before "deployment"
```

### 4. Recent Activity
Quick check on last session:
```bash
node transcript-query.mjs recent
```

## Data Available

Each parsed transcript includes:
- **Messages**: All user/assistant messages
- **Tool Uses**: Every tool called with parameters
- **Files Modified**: All Edit/Write operations
- **Errors**: Any errors encountered
- **Timeline**: Timestamp for every event
- **Metadata**: Working directory, git branch, duration
- **Key Topics**: Automatically extracted keywords

## Performance Notes

- **Lazy loading**: Transcripts parsed only when needed
- **File size**: A 3-hour session is typically 5-10MB
- **Parse time**: ~100-200ms per transcript
- **Memory**: Parsed data ~10% of file size

For projects with 100+ sessions, consider:
- Caching parsed results
- Building an index in Mech Storage
- Using vector embeddings for semantic search

## Future Enhancements

1. **Semantic search** with Mech Search embeddings
2. **Auto-summarization** using Claude API
3. **Pattern detection** (common workflows, recurring issues)
4. **Skill extraction** (identify reusable approaches)
5. **Decision tracking** (why did we choose X over Y?)

## Troubleshooting

**"No transcripts found"**
- Check that project path is absolute
- Verify transcripts exist in `~/.gemini/projects/`
- Try with explicit path: `node transcript-query.mjs list /absolute/path`

**"Session not found"**
- Session ID must be exact match
- Or provide full path to .jsonl file

**Parse errors**
- Some transcript formats may vary
- Parser handles most common cases
- Check transcript is valid JSONL

## See Also

- SKILL.md - Full documentation
- lib/transcript-parser.js - Implementation
- transcript-query.mjs - CLI tool
