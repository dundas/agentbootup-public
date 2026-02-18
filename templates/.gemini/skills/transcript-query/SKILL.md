# Transcript Query

## Purpose
Query and analyze Gemini CLI session transcripts to answer questions about previous work, decisions, and context.

## Use Cases

1. **Contextual Memory**: "What were we working on before X?"
2. **Decision Tracking**: "Why did we choose approach Y?"
3. **Issue History**: "What errors did we encounter with Z?"
4. **File History**: "When did we modify file X?"
5. **Timeline Reconstruction**: "Show me all work on feature Y"

## How It Works

Gemini CLI stores session transcripts as JSONL files in `~/.gemini/projects/<project-path>/<session-id>.jsonl`.

This skill:
1. Parses transcript JSONL files
2. Extracts structured data (messages, tool uses, files, errors)
3. Searches by keyword, date, topic
4. Reconstructs context and timeline

## Usage

### Answer "What were we working on before X?"

```javascript
import { TranscriptParser } from './lib/transcript-parser.js';

const parser = new TranscriptParser();
const result = await parser.findWorkBefore(
  process.cwd(),  // Current project path
  'memory sync daemon'  // Topic to find
);

if (result.found) {
  console.log('Previous work:');
  result.previousSessions.forEach(s => {
    console.log(`\n## ${new Date(s.startTime).toISOString()}`);
    console.log(`Branch: ${s.gitBranch}`);
    console.log(`Key topics: ${s.keyTopics.join(', ')}`);
    console.log(`Summary: ${s.summary.messageCount} messages, ${s.summary.filesModifiedCount} files changed`);
  });
}
```

### Search for specific topic

```javascript
const transcripts = await parser.listTranscripts(process.cwd());

for (const transcript of transcripts) {
  const data = await parser.parseTranscript(transcript.path);
  const matches = parser.searchMessages(data, 'authentication');

  if (matches.length > 0) {
    console.log(`Found in ${transcript.sessionId}:`);
    matches.forEach(m => {
      console.log(`  [${m.type}] ${m.content.substring(0, 100)}...`);
    });
  }
}
```

### Get session summary

```javascript
const recent = await parser.getMostRecentTranscript(process.cwd());
const data = await parser.parseTranscript(recent.path);

console.log('Most recent session:');
console.log(`  Duration: ${data.summary.durationFormatted}`);
console.log(`  Messages: ${data.summary.messageCount}`);
console.log(`  Files modified: ${data.summary.filesModifiedCount}`);
console.log(`  Errors: ${data.summary.errorCount}`);
```

### Find context around a message

```javascript
const data = await parser.parseTranscript(transcriptPath);
const context = parser.findContextBefore(
  data,
  'lets merge',  // Target message
  5  // Number of context messages
);

if (context) {
  console.log('Context before "lets merge":');
  context.contextMessages.forEach(m => {
    console.log(`[${m.type}] ${m.content}`);
  });
}
```

## Integration with Claude

When Claude needs to answer questions about previous work, it can:

1. **Check current project path** from `process.cwd()`
2. **List available transcripts** for the project
3. **Search for relevant sessions** by keyword/topic
4. **Extract context** from previous sessions
5. **Present findings** to user

### Example: Autonomous usage

```javascript
// When user asks: "what were we working on before the daemon?"

async function answerContextQuestion(question) {
  const parser = new TranscriptParser();

  // Extract key terms from question
  const searchTerm = extractKeyTerm(question); // e.g., "daemon"

  // Find relevant work
  const result = await parser.findWorkBefore(process.cwd(), searchTerm);

  if (result.found) {
    // Construct answer from previous sessions
    return `Before working on ${searchTerm}, we were working on:\n\n` +
      result.previousSessions.map(s =>
        `- ${new Date(s.startTime).toLocaleDateString()}: ${s.keyTopics.slice(0, 3).join(', ')} ` +
        `(${s.summary.filesModifiedCount} files changed)`
      ).join('\n');
  } else {
    return `No previous sessions found before ${searchTerm}.`;
  }
}
```

## Integration Points

### 1. Session Start Hook

Load recent context automatically:

```javascript
// .gemini/hooks/session_start_with_transcript.mjs
import { TranscriptParser } from './skills/transcript-query/lib/transcript-parser.js';

const parser = new TranscriptParser();
const recent = await parser.getMostRecentTranscript(process.cwd());

if (recent) {
  const data = await parser.parseTranscript(recent.path);
  console.log(`Last session: ${data.summary.durationFormatted} ago`);
  console.log(`Topics: ${parser.extractKeyTopics(data).slice(0, 3).join(', ')}`);
}
```

### 2. Memory Sync Daemon

Background indexing of transcripts:

```javascript
// Watch for new transcripts
const watcher = fs.watch(parser.projectsDir, { recursive: true });

for await (const event of watcher) {
  if (event.filename.endsWith('.jsonl')) {
    // Index new transcript
    const data = await parser.parseTranscript(event.filename);
    // Store in searchable index (Mech Storage)
    await indexTranscript(data);
  }
}
```

### 3. Command Interface

Add CLI commands:

```bash
# Query transcripts
node transcript-query.mjs search "authentication"
node transcript-query.mjs before "daemon"
node transcript-query.mjs recent
node transcript-query.mjs summary <session-id>
```

## Data Structure

Parsed transcript structure:

```javascript
{
  sessionId: "uuid",
  startTime: "2026-02-05T14:52:26.457Z",
  endTime: "2026-02-05T18:30:15.123Z",
  cwd: "/path/to/project",
  gitBranch: "feat/branch-name",

  messages: [
    {
      type: "user" | "assistant",
      content: "message text",
      timestamp: "ISO 8601",
      uuid: "message-uuid"
    }
  ],

  toolUses: [
    {
      tool: "Read" | "Edit" | "Write" | ...,
      parameters: {},
      timestamp: "ISO 8601"
    }
  ],

  filesModified: [
    {
      path: "relative/path/to/file",
      action: "Edit" | "Write",
      timestamp: "ISO 8601"
    }
  ],

  errors: [
    {
      message: "error description",
      timestamp: "ISO 8601"
    }
  ],

  summary: {
    messageCount: 42,
    userMessageCount: 15,
    toolUseCount: 87,
    filesModifiedCount: 12,
    errorCount: 2,
    durationMs: 13789000,
    durationFormatted: "3h 49m 49s"
  }
}
```

## Performance Considerations

- **Lazy loading**: Only parse transcripts when needed
- **Caching**: Cache parsed transcripts in memory
- **Indexing**: For large projects, maintain a searchable index
- **Async**: All file operations are async

## Future Enhancements

1. **Vector embeddings**: Use Mech Search for semantic queries
2. **Automatic summarization**: Use Claude API to summarize sessions
3. **Trend analysis**: Track patterns over time
4. **Skill extraction**: Automatically identify reusable patterns
5. **Decision graph**: Build graph of decisions and their outcomes

## Security & Privacy

- Transcripts contain full conversation history
- May include sensitive data (credentials, keys, personal info)
- Keep transcripts local or encrypt before cloud storage
- This skill only reads, never modifies transcripts

## Dependencies

- Node.js >= 18 (for fs/promises)
- Gemini CLI (generates .jsonl transcripts)

## Testing

```bash
# Run parser tests
node test-transcript-parser.mjs

# Test with current project
node -e "
import { TranscriptParser } from './lib/transcript-parser.js';
const parser = new TranscriptParser();
const transcripts = await parser.listTranscripts(process.cwd());
console.log(\`Found \${transcripts.length} transcripts\`);
"
```

## References

- Gemini CLI transcript format: `.gemini/projects/<project>/<session>.jsonl`
- JSONL spec: https://jsonlines.org/
- Session hooks: `.gemini/hooks/` directory
