# Self-Improvement Protocol

## Overview

This protocol defines how autonomous agents learn from their own sessions, curate knowledge, and propagate learnings across a network of brains. It is the operational guide for turning raw experience into permanent, reusable knowledge.

## The Self-Improvement Loop

```
┌──────────────────────────────────────────────────┐
│              CONTINUOUS LEARNING LOOP             │
│                                                    │
│  1. WORK    → Agent completes coding sessions    │
│  2. RECORD  → Transcripts saved automatically    │
│  3. ANALYZE → Extract insights via LLM           │
│  4. CURATE  → Filter noise, keep signal          │
│  5. STORE   → Write to memory/daily + MEMORY.md  │
│  6. APPLY   → Consult memory in next session     │
│  7. SHARE   → Propagate to other brains          │
│                                                    │
│  Repeat forever.                                  │
└──────────────────────────────────────────────────┘
```

## Step 1: Transcript Analysis

### When to Analyze

- **Automatically**: The memory-sync daemon runs `TranscriptAnalyzer` hourly
- **On demand**: Run `analyze-transcripts` CLI after significant sessions
- **At session end**: Hook triggers analysis of the just-completed session

### How to Run

```bash
# Analyze last 24 hours (default)
analyze-transcripts

# Analyze specific project
analyze-transcripts --project ~/dev_env/myproject

# Analyze everything from scratch
analyze-transcripts --reset --all

# Preview without writing
analyze-transcripts --dry-run --verbose

# Check stats
analyze-transcripts --stats
```

### What Gets Extracted

The LLM analyzes each session transcript and extracts:

| Category | Description | Example |
|----------|-------------|---------|
| **Technical Learnings** | New APIs, patterns, techniques | "npm requires `_authToken` (capital T) in .npmrc" |
| **Skills Developed** | New capabilities acquired | "Built fuzzy search with Levenshtein distance" |
| **Mistakes & Corrections** | Errors and how they were fixed | "Wrong directory → always verify `pwd` before git ops" |
| **Strategic Decisions** | Choices made with rationale | "Chose REST over GraphQL for MVP simplicity" |
| **Patterns** | Recurring approaches worth remembering | "Always self-review before creating PR" |

### Significance Filter

Not every session is worth analyzing. Sessions are skipped if:
- Fewer than 10 messages
- No files modified
- No errors encountered
- Duration under 5 minutes

## Step 2: Memory Curation

### Two-Tier Memory System

**Tier 1: Daily Logs** (`memory/daily/YYYY-MM-DD.md`)
- Every analyzed session gets logged here
- Full detail: learnings, mistakes, decisions, patterns
- No curation - everything significant goes in
- Useful for recent context and session history

**Tier 2: Long-Term Memory** (`memory/MEMORY.md`)
- Only the most significant learnings
- Must pass significance filter (keywords + length)
- Deduplicated against existing content
- Kept under 200 lines (auto-trimmed)
- Loaded into every session's system prompt

### Significance Criteria for MEMORY.md

A learning is significant if it contains keywords like:
`never`, `always`, `critical`, `important`, `pattern`, `security`, `must`, `required`, `breaking`, `gotcha`, `bug`, `fix`

OR if it is substantial (>50 characters of specific, actionable insight).

### Deduplication

Before writing to MEMORY.md, each learning is checked against existing content:
1. **Exact substring match** - skip if already present
2. **Word overlap >70%** - skip if substantially similar

This prevents the same insight from accumulating multiple times.

### Auto-Trimming

When MEMORY.md exceeds 200 lines:
1. Find `### Auto-extracted` sections (oldest first)
2. Remove oldest sections until under 200 lines
3. Hand-written content is never removed

**Best practice**: Periodically review auto-extracted learnings and either:
- Promote them to hand-written sections (permanent)
- Delete them if no longer relevant

## Step 3: Applying Learnings

### Session Start Protocol

Every session should begin by consulting memory:

1. **Read `memory/MEMORY.md`** - Core knowledge loaded automatically via CLAUDE.md
2. **Read today's daily log** - `memory/daily/YYYY-MM-DD.md` for recent context
3. **Check for relevant past mistakes** - Search memory for keywords related to current task

### Decision-Making with Memory

When making a decision, the agent should:

1. Check if a similar decision was made before (search memory)
2. Check if there are recorded patterns or anti-patterns
3. Apply any "never do X" or "always do Y" rules
4. Document the new decision for future reference

### Pattern Recognition

Over time, the memory system accumulates patterns:

- **Anti-patterns**: Things that failed (e.g., "Never use lowercase `_authtoken` in .npmrc")
- **Best practices**: Things that worked (e.g., "Always verify directory before git operations")
- **Shortcuts**: Efficient approaches (e.g., "Use `--dry-run` flags before destructive operations")

## Step 4: Skill Extraction

When a learning represents a **reusable capability**, it should be extracted as a formal skill:

### When to Create a Skill

- The capability was used more than once
- It involves specific API knowledge or workflow steps
- It would benefit from documentation and examples
- It's not already covered by an existing skill

### Skill Structure

```
.claude/skills/skill-name/
├── SKILL.md       # Workflow, instructions, examples
└── reference.md   # Technical details, API specs
```

### Extraction Process

1. Identify the capability from daily logs or MEMORY.md
2. Create skill directory and SKILL.md
3. Document the workflow step-by-step
4. Add reference material and examples
5. Test the skill in a real scenario
6. Update MEMORY.md skills list
7. Propagate to other brains if applicable

## Step 5: Multi-Brain Learning Propagation

### Architecture

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Brain A   │    │   Brain B   │    │   Brain C   │
│  Project X  │    │  Project Y  │    │  Project Z  │
└──────┬──────┘    └──────┬──────┘    └──────┬──────┘
       │                  │                  │
       └──────────┬───────┴──────────┬───────┘
                  │                  │
           ┌──────▼──────┐   ┌──────▼──────┐
           │ Mech Storage│   │  agentbootup │
           │  (sync hub) │   │  (templates) │
           └─────────────┘   └──────────────┘
```

### Propagation Channels

**Channel 1: Memory Sync Daemon**
- Each brain runs `memory-sync-daemon`
- Pushes memory changes to Mech Storage
- Other brains pull on startup
- Automatic, continuous, bidirectional

**Channel 2: agentbootup Templates**
- Curated learnings baked into templates
- `npx agentbootup` seeds new projects with latest knowledge
- Version-controlled via npm (e.g., `agentbootup@0.7.0`)

**Channel 3: Skill Sharing**
- New skills created in `.claude/skills/`
- Synced to Mech Storage via memory-sync
- Other brains discover and install via sync
- Common skills promoted to agentbootup templates

### What Gets Propagated

| Content | Channel | Audience | Frequency |
|---------|---------|----------|-----------|
| Daily logs | Memory Sync | Same brain | Real-time |
| MEMORY.md | Memory Sync | Same brain + clones | Real-time |
| Skills | Memory Sync + agentbootup | All brains | On creation |
| Protocols | agentbootup templates | All new projects | On npm publish |
| Anti-patterns | MEMORY.md → templates | All brains | Periodic curation |

### Propagation Rules

1. **Daily logs stay local** - they're project-specific context
2. **MEMORY.md syncs to Mech Storage** - accessible by same brain across sessions
3. **Skills sync bidirectionally** - all brains benefit
4. **Critical learnings get promoted** - from MEMORY.md to agentbootup templates
5. **Project-specific knowledge stays project-specific** - don't pollute other brains

### Conflict Resolution

When two brains learn conflicting patterns:

1. **Most recent wins** for factual corrections (API changed, etc.)
2. **Project-specific overrides general** for context-dependent patterns
3. **Human-written overrides auto-extracted** always
4. **Flag conflicts for human review** when impact is unclear

## Step 6: Measuring Improvement

### Metrics to Track

Run `analyze-transcripts --stats` to see:

- **Sessions analyzed**: Total sessions processed
- **Insights extracted**: Total learnings found
- **MEMORY.md updates**: Times long-term memory was updated
- **Last analysis**: When analysis last ran

### Qualitative Indicators

- Fewer repeated mistakes in daily logs
- More patterns being applied proactively
- Skills being reused across projects
- Less time spent on previously-solved problems

## Quick Start: Enabling Self-Improvement

### For a New Project

```bash
# 1. Install agentbootup
npx agentbootup

# 2. Set up environment
export MECH_APP_ID=your-app-id
export MECH_API_KEY=your-api-key

# 3. Run initial analysis
analyze-transcripts --all --verbose

# 4. Start the daemon for continuous analysis
memory-sync-daemon start
```

### For an Existing Brain

```bash
# 1. Update to latest agentbootup
npx agentbootup

# 2. Analyze historical sessions
analyze-transcripts --reset --all

# 3. Review generated memory files
cat memory/MEMORY.md
ls memory/daily/

# 4. Enable continuous analysis
# Add to brain startup or cron:
# analyze-transcripts --hours 2
```

### For Deploying to Company Brains

1. **Curate learnings** from your best brain's MEMORY.md
2. **Promote to templates** in agentbootup
3. **Publish**: `npm publish` (bumps version)
4. **Deploy**: Run `npx agentbootup` in each project brain
5. **Enable sync**: Configure `memory-sync-daemon` with Mech credentials
6. **Monitor**: Check `analyze-transcripts --stats` periodically

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MECH_APP_ID` | Yes | Mech application ID for LLM access |
| `MECH_API_KEY` | Yes | Mech API key |
| `MECH_LLM_URL` | No | Custom Mech LLMs URL (default: https://llms.mechdna.net) |

### Daemon Configuration

The `TranscriptAnalyzer` accepts these options:

```javascript
{
  basePath: '/path/to/project',      // Where memory/ lives
  projectPath: '/path/to/project',   // Which project's transcripts to analyze
  llmClient: mechLLMsClient,         // Mech LLMs API client
  checkIntervalMs: 3600000           // How often to check (default: 1 hour)
}
```

## Related Documentation

- `lib/analysis/README.md` - Technical architecture of analysis system
- `.ai/protocols/AUTONOMOUS_OPERATION.md` - Decision-making and memory protocols
- `memory/README.md` - Memory system overview
- `.ai/skills/memory-manager/` - Memory management automation
- `.ai/skills/skill-acquisition/` - Skill building workflow
