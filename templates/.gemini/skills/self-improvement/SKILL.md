# Self-Improvement Skill

## Goal

Enable any agent to continuously learn from its own coding sessions, build permanent knowledge, and share learnings across a network of brains.

## When to Use

- At the **start of each session**: Load memory and apply past learnings
- At the **end of significant sessions**: Trigger analysis to extract insights
- **Periodically**: Run analysis on recent sessions to catch anything missed
- **When deploying new brains**: Propagate accumulated knowledge to new instances

## Prerequisites

- `agentbootup` installed in the project (`npx agentbootup`)
- `MECH_APP_ID` and `MECH_API_KEY` environment variables set
- `memory/` directory exists in project root

## Workflow

### Phase 1: Analyze Sessions

Run transcript analysis to extract insights from recent coding sessions.

```bash
# Analyze last 24 hours
analyze-transcripts

# Analyze all unprocessed sessions
analyze-transcripts --all

# Preview what would be analyzed
analyze-transcripts --dry-run --verbose
```

**What happens:**
1. Finds Gemini CLI session transcripts for this project
2. Filters to recent/unprocessed sessions
3. Parses each transcript (messages, files modified, errors)
4. Sends session context to LLM for insight extraction
5. Writes insights to `memory/daily/YYYY-MM-DD.md`
6. Updates `memory/MEMORY.md` with significant learnings (deduplicated)

### Phase 2: Review and Curate

After analysis, review what was extracted:

```bash
# Check today's daily log
cat memory/daily/$(date +%Y-%m-%d).md

# Check what was added to long-term memory
git diff memory/MEMORY.md

# View analysis statistics
analyze-transcripts --stats
```

**Curation actions:**
- **Promote**: Move auto-extracted insights to hand-written sections in MEMORY.md
- **Refine**: Edit auto-extracted text for clarity and precision
- **Remove**: Delete insights that are incorrect or not useful
- **Extract skill**: If a learning is a reusable capability, create a skill

### Phase 3: Apply in Next Session

At session start, memory is automatically loaded via CLAUDE.md. The agent should:

1. Check `memory/MEMORY.md` for relevant patterns and anti-patterns
2. Check recent daily logs for context on current work
3. Apply "never do X" rules to avoid past mistakes
4. Use learned patterns to make better decisions

### Phase 4: Share Across Brains

For multi-brain setups:

1. **Memory sync daemon** pushes/pulls memory changes via Mech Storage
2. **agentbootup templates** carry curated knowledge to new projects
3. **Skills** are shared when synced to Mech Storage

## Commands

| Command | Description |
|---------|-------------|
| `analyze-transcripts` | Analyze recent sessions (last 24h) |
| `analyze-transcripts --all` | Analyze all unprocessed sessions |
| `analyze-transcripts --hours 168` | Analyze last week |
| `analyze-transcripts --session abc123` | Analyze specific session |
| `analyze-transcripts --dry-run` | Preview without writing |
| `analyze-transcripts --verbose` | Show extracted insights |
| `analyze-transcripts --reset --all` | Re-analyze everything |
| `analyze-transcripts --stats` | Show analysis statistics |
| `memory-sync-daemon start` | Start continuous sync |

## Memory Architecture

```
memory/
├── MEMORY.md              ← Long-term (loaded every session, <200 lines)
├── README.md              ← System documentation
└── daily/
    ├── 2026-02-05.md      ← Today's session logs
    ├── 2026-02-04.md      ← Yesterday's logs
    └── ...
```

### MEMORY.md Structure

```markdown
# Autonomous Memory System

## Core Identity
(Agent name, role, purpose)

## Critical Learnings
### Auto-extracted (2026-02-05)
- Learning from transcript analysis
- Another learning

### Hand-written
- Curated permanent knowledge

## Skills Acquired (N)
- List of capabilities

## Standing Orders
- Always-active behavioral rules
```

### Daily Log Structure

```markdown
# Daily Log: 2026-02-05

## Session abc12345 (14:30)
**Summary:** Built fuzzy search for transcript queries
**Duration:** 2h 15m
**Activity:** 45 messages, 8 files modified

### Technical Learnings
- Levenshtein distance catches typos within threshold of 2

### Mistakes & Corrections
- **Mistake:** Wrong stemming suffix order
  - **Correction:** Apply longer suffixes first
  - **Lesson:** Order matters in sequential string operations
```

## Significance Criteria

Not all learnings make it to MEMORY.md. To qualify, a learning must:

1. **Contain a signal keyword**: never, always, critical, important, security, must, bug, fix, pattern, breaking, gotcha, workaround
2. **OR be substantial**: More than 50 characters of specific, actionable insight

Learnings that are too generic ("learned about APIs") or too short are kept in daily logs only.

## Deploying to Company Brains

### Step 1: Curate Your Knowledge

Review your brain's `memory/MEMORY.md` and identify universally valuable learnings.

### Step 2: Promote to Templates

Add curated knowledge to agentbootup templates:
- `templates/memory/MEMORY.md` - Default memory template
- `templates/.ai/protocols/SELF_IMPROVEMENT.md` - This protocol
- `templates/.gemini/skills/self-improvement/` - This skill

### Step 3: Publish

```bash
cd ~/dev_env/agentbootup
# Bump version in package.json
npm publish
```

### Step 4: Deploy to Each Brain

```bash
cd ~/dev_env/project-brain
npx agentbootup
```

### Step 5: Enable Continuous Learning

Each brain needs:
1. `MECH_APP_ID` and `MECH_API_KEY` in environment
2. `analyze-transcripts` run periodically (cron or daemon)
3. `memory-sync-daemon` for cross-session persistence

## Error Handling

| Error | Cause | Fix |
|-------|-------|-----|
| "MECH_APP_ID required" | Missing env vars | Set MECH_APP_ID and MECH_API_KEY |
| "No transcripts found" | Wrong project path | Use `--project` to specify correct path |
| "Session not significant" | Too few messages/changes | Normal - only substantial sessions get analyzed |
| "All learnings already in MEMORY.md" | Dedup working correctly | Normal - prevents duplicates |
| LLM API error | Mech service issue | Check credentials, retry later |

## References

- `templates/.ai/protocols/SELF_IMPROVEMENT.md` - Full protocol documentation
- `lib/analysis/README.md` - Technical architecture
- `templates/.ai/protocols/AUTONOMOUS_OPERATION.md` - Autonomous behavior rules
- `templates/.ai/skills/memory-manager/SKILL.md` - Memory management skill
