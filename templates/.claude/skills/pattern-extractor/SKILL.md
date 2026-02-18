---
name: pattern-extractor
description: Automatically analyze transcripts to extract error patterns, success patterns, and decision patterns. Updates technical-patterns.md and suggests code-level improvements.
category: learning
---

# Pattern Extractor

## Purpose
Close the learning loop by automatically analyzing transcript history to extract patterns, update technical knowledge, and suggest preventive measures.

## Goal
Transform experience into actionable knowledge without manual intervention.

## Use Cases

1. **Automated Learning**: Extract lessons from recent work
2. **Error Prevention**: Find repeated mistakes and suggest pre-flight checks
3. **Best Practices**: Identify successful patterns to replicate
4. **Decision Documentation**: Capture decision rationale for future reference
5. **Cross-Brain Knowledge**: Generate insights for sharing with other brains

## When to Use

**Trigger automatically**:
- Daily (via cron): Extract patterns from last 24 hours
- Weekly: Extract patterns from last 7 days
- After major work: Extract patterns from specific session

**Trigger manually**:
- After encountering repeated errors
- Before starting similar work (learn from past attempts)
- When updating technical-patterns.md

## Usage

```bash
# Extract patterns from recent transcripts
/pattern-extractor --last 7

# Extract specific pattern types
/pattern-extractor --errors-only --last 30
/pattern-extractor --decisions-only --since "2026-02-01"
/pattern-extractor --successes-only --last 14

# Update technical patterns file
/pattern-extractor --last 30 --update-file memory/technical-patterns.md

# Generate pre-flight checks from errors
/pattern-extractor --generate-checks --last 90

# Export for cross-brain sharing
/pattern-extractor --last 7 --format json --output patterns.json
```

## Process

### 1. Transcript Analysis
- Load transcripts from specified time range (uses transcript-query)
- Parse tool uses, errors, user feedback, outcomes
- Build timeline of activities

### 2. Pattern Detection

**Error Patterns**:
```
Analyze for:
- Tool errors (Read failed, Edit failed, Bash failed)
- Repeated mistakes (same error multiple times)
- Error sequences (Error A → leads to → Error B)
- Root causes (what triggered the error chain)
```

**Success Patterns**:
```
Analyze for:
- Successful completions (task done, tests pass, user approves)
- Techniques that worked (tool sequences, approaches)
- Fast resolutions (problem → solution quickly)
- User praise (positive feedback patterns)
```

**Decision Patterns**:
```
Analyze for:
- Architecture decisions (chose X over Y because Z)
- Trade-offs considered (pros/cons lists)
- Rationale documented (why this approach)
- Alternatives rejected (what was considered but not chosen)
```

### 3. Pattern Categorization

**Anti-Patterns** (things to avoid):
- Frequency: How often does this mistake occur?
- Impact: What's the cost (time lost, bugs introduced)?
- Root cause: Why does this happen?
- Prevention: How to stop it?

**Best Practices** (things to replicate):
- Success rate: How reliably does this work?
- Context: When is this applicable?
- Steps: What's the procedure?
- Metrics: How to measure success?

**Decisions** (for future reference):
- Problem: What was being solved?
- Solution: What was chosen?
- Reasoning: Why was this the best option?
- Outcome: Did it work?

### 4. Knowledge Base Update

**Update technical-patterns.md**:
```markdown
## Anti-Patterns (Last Updated: 2026-02-06)

### Pattern: Always Read before Write/Edit
**Frequency**: 22 occurrences (last 90 days)
**Impact**: File operations fail, wasted time
**Root Cause**: Assumption file exists without verification
**Prevention**:
- Pre-flight check: Has this file been read in session?
- Auto-suggest: "File not read yet - would you like to read it first?"
**Last Seen**: 2026-02-05 (session abc123...)

### Pattern: Verify paths when switching repos
**Frequency**: 21 occurrences (last 90 days)
**Impact**: Operations on wrong files, potential data loss
**Root Cause**: Context switching without path verification
**Prevention**:
- Pre-flight check: Verify cwd matches expected repo
- Prompt pattern: "Working in {repo} - is this correct?"
**Last Seen**: 2026-02-04 (session def456...)
```

**Update best-practices.md** (if exists):
```markdown
## Best Practices (Last Updated: 2026-02-06)

### Pattern: Use native FormData for file uploads
**Success Rate**: 100% (5/5 attempts)
**Context**: Uploading files to APIs requiring multipart/form-data
**Steps**:
1. Create FormData instance
2. Append file as Blob (not Buffer)
3. Let fetch auto-set Content-Type boundary
4. Don't manually set Content-Type header
**Metrics**: Zero upload failures after adopting this pattern
**First Success**: 2026-02-05 (mech-llms audio upload)
```

### 5. Generate Preventive Measures

**Pre-flight Checks** (code suggestions):
```javascript
// Suggested pre-flight check for Write/Edit tools
function preWriteCheck(filePath, sessionContext) {
  const hasBeenRead = sessionContext.filesRead.includes(filePath);

  if (!hasBeenRead) {
    return {
      warning: true,
      message: `File ${filePath} has not been read in this session. Read it first?`,
      suggestion: `Read(${filePath})`
    };
  }

  return { warning: false };
}
```

**Tool Wrappers** (safety layer):
```javascript
// Suggested wrapper for Bash tool when switching repos
async function safeBash(command, expectedRepo) {
  const cwd = process.cwd();

  if (!cwd.includes(expectedRepo)) {
    const userConfirm = await askUser(
      `Command will run in ${cwd}. Expected ${expectedRepo}. Continue?`
    );
    if (!userConfirm) return { cancelled: true };
  }

  return await Bash(command);
}
```

### 6. Output Formats

**Markdown** (human-readable, for memory files):
```markdown
# Pattern Analysis: 2026-02-06

## Summary
- Transcripts analyzed: 42 (last 30 days)
- Error patterns found: 8
- Success patterns found: 12
- Decisions documented: 6

## New Insights
...
```

**JSON** (machine-readable, for cross-brain sharing):
```json
{
  "generated": "2026-02-06T14:30:00Z",
  "period": {
    "days": 30,
    "transcripts": 42,
    "sessions": 38
  },
  "patterns": {
    "errors": [
      {
        "pattern": "Read before Write violation",
        "frequency": 22,
        "impact": "high",
        "prevention": "pre-flight check",
        "code": "function preWriteCheck() { ... }"
      }
    ],
    "successes": [...],
    "decisions": [...]
  }
}
```

## Integration Points

### 1. Daily Automation (cron)
```bash
# Run daily at 6am, update technical patterns
0 6 * * * cd ~/dev_env/decisive_redux && /pattern-extractor --last 1 --update-file memory/technical-patterns.md
```

### 2. Session Start Hook
```javascript
// Load recent patterns at session start
import { exec } from 'child_process';

const patterns = await exec('pattern-extractor --last 7 --format json');
console.log(`📊 Recent patterns: ${patterns.errors.length} errors, ${patterns.successes.length} wins`);
```

### 3. Pre-Tool Execution Hooks
```javascript
// Before Write tool
const writeCheck = await exec(`pattern-extractor --check Write --file ${filePath}`);
if (writeCheck.warnings.length > 0) {
  // Show warnings to user
}
```

### 4. Cross-Brain Knowledge Sharing
```javascript
// Extract patterns and broadcast to AgentDispatch hub
const patterns = await exec('pattern-extractor --last 7 --format json');

await agentDispatch.broadcast({
  type: 'knowledge_share',
  from: 'decisive-gm',
  patterns: patterns,
  timestamp: new Date().toISOString()
});
```

## Architecture

### Dependencies
- `transcript-query` skill (transcript parsing)
- Node.js fs/promises (file I/O)
- Optional: `mech-llms` (Claude API for pattern summarization)

### File Structure
```
.claude/skills/pattern-extractor/
├── SKILL.md                   # This file
├── pattern-extractor.mjs      # CLI entry point
├── lib/
│   ├── pattern-detector.js    # Core pattern detection logic
│   ├── error-analyzer.js      # Error pattern analysis
│   ├── success-analyzer.js    # Success pattern analysis
│   ├── decision-analyzer.js   # Decision pattern analysis
│   └── check-generator.js     # Pre-flight check code generation
└── templates/
    ├── technical-patterns.md  # Template for pattern doc
    └── pre-flight-checks.js   # Template for checks
```

## Key Algorithms

### Pattern Detection Algorithm
```
For each transcript in time range:
  1. Parse tool uses and outcomes
  2. Identify error sequences
  3. Detect repeated patterns (same error multiple times)
  4. Find successful completions
  5. Extract decision points

Group similar patterns:
  - Cluster by error message similarity
  - Cluster by tool sequence similarity
  - Cluster by decision context

Rank by importance:
  - Frequency × Impact = Priority
  - High priority patterns bubble up
```

### Prevention Suggestion Algorithm
```
For each error pattern:
  1. Identify trigger condition
  2. Determine detection point (when can we catch this?)
  3. Generate pre-flight check code
  4. Suggest integration point (which tool hook?)

Example:
  Error: "Write failed - file not read"
  Trigger: Write tool called without prior Read
  Detection: Before Write execution
  Check: Has file been read in session?
  Integration: Pre-Write hook
```

## Output Example

```markdown
# Pattern Analysis Report
**Generated**: 2026-02-06 14:30 UTC
**Period**: Last 30 days (42 transcripts)

---

## 🔴 High-Priority Anti-Patterns

### 1. Read-Before-Write Violation
**Occurrences**: 22 times (0.73/day)
**Impact**: High (causes file operation failures)
**Cost**: ~15 min/occurrence = 5.5 hours wasted

**Pattern**:
```
Write(file.ts) → Error: "File not read"
→ Read(file.ts)
→ Write(file.ts) → Success
```

**Root Cause**: Assumption that file context is available without reading

**Prevention**:
```javascript
// Suggested pre-Write hook
if (!session.filesRead.includes(targetFile)) {
  warn("File not read. Reading automatically...");
  await Read(targetFile);
}
```

**Recommendation**: Implement pre-flight check ✅ HIGH PRIORITY

---

## ✅ Successful Patterns to Replicate

### 1. Native FormData for Uploads
**Success Rate**: 100% (5/5)
**Context**: File uploads to external APIs

**Pattern**:
```javascript
const formData = new FormData();
formData.append('file', new Blob([fileBuffer]), filename);
// Let fetch auto-set Content-Type - don't set manually
const response = await fetch(url, { method: 'POST', body: formData });
```

**Why it works**: APIs like Together.ai need proper boundary in Content-Type

**When to use**: Any external API requiring multipart/form-data

---

## 📋 Recent Decisions

### 1. Agent Teams Integration in dev-workflow-orchestrator
**Date**: 2026-02-06
**Context**: Should workflow offer agent teams automatically?
**Decision**: Yes, with analysis phase
**Reasoning**:
- Intelligent automation - offers when beneficial
- User maintains control - can decline
- Clear cost/benefit - shows 3-5x token cost vs 2-3x speed
**Alternatives Considered**:
- ❌ Always use teams (too expensive)
- ❌ Never suggest teams (misses opportunities)
- ✅ Analyze and suggest (balanced approach)
**Outcome**: Implemented in phase 3 of workflow

---

## 🎯 Recommendations

1. **Implement pre-flight checks** (code provided above) - prevents 22 errors/month
2. **Replicate FormData pattern** - 100% success rate for uploads
3. **Document decision pattern** - agent teams suggestion logic is reusable

---

**Next Pattern Extraction**: 2026-02-07 06:00 UTC (automated)
```

## Limitations

- Pattern detection requires clean transcript data
- Code generation is suggestions only (needs review)
- Cross-brain patterns need standardized format
- May miss subtle patterns that humans would catch

## Future Enhancements

1. **ML-based pattern detection**: Use embeddings to find semantic patterns
2. **Auto-fix suggestions**: Generate full PR for common fixes
3. **Pattern prediction**: "You're about to make error X based on context"
4. **Cross-repo patterns**: Find patterns across portfolio projects
5. **User feedback loop**: Track if suggested patterns actually help

## Security & Privacy

- Patterns may contain sensitive information from transcripts
- Filter out credentials, API keys, personal data
- Sanitize before cross-brain sharing
- Respect transcript privacy settings

---

**Created**: 2026-02-06
**Dependencies**: transcript-query, Node.js 18+
**Related Skills**: brain-briefing, transcript-query, memory-manager
**Status**: Ready to implement
