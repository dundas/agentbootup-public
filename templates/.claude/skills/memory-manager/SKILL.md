---
name: memory-manager
description: Manage persistent memory across sessions - daily notes, long-term knowledge, and semantic retrieval.
category: autonomous
---

# Memory Manager

## Goal
Maintain persistent context across all sessions through a three-layer memory system.

## Memory Layers

### Layer 1: Daily Notes
**Location:** `memory/daily/YYYY-MM-DD.md`
**Purpose:** Raw session logs and interaction history
**Update:** After each significant interaction

### Layer 2: Long-Term Memory
**Location:** `memory/MEMORY.md`
**Purpose:** Curated knowledge, preferences, decisions
**Update:** When learning important context

### Layer 3: Semantic Index (Optional)
**Location:** `memory/embeddings/`
**Purpose:** Vector search for conceptual retrieval
**Update:** Periodically index memory content

## Process

### Writing to Daily Notes

After significant interactions, append:
```markdown
## HH:MM - [Session Type]

**User:** [Request summary]
**Agent:** [Action taken]

### Details
- Key decisions made
- Files modified
- Outcomes achieved

### Follow-up
- Pending items
- Questions to revisit
```

### Updating Long-Term Memory

When learning important context:
```markdown
## [Category]

### [Topic]
- Key fact or preference
- Supporting details
- Date learned: YYYY-MM-DD
```

Categories to maintain:
- **User Preferences**: Communication style, tool preferences, work patterns
- **Project Context**: Tech stack, architecture decisions, key files
- **Important Decisions**: What was decided and why
- **Learned Patterns**: Shortcuts, conventions, recurring needs

### Memory Retrieval

Before responding to any request:
1. Check if MEMORY.md has relevant context
2. Scan recent daily notes (today, yesterday)
3. For complex queries, search semantically if available

### Memory Consolidation

Periodically (or when daily notes grow large):
1. Review recent daily notes
2. Extract patterns and important facts
3. Update MEMORY.md with distilled knowledge
4. Archive old daily notes if needed

## Memory Templates

### Initial MEMORY.md
```markdown
# Agent Memory

*Last updated: YYYY-MM-DD*

## User Profile

### Preferences
- [To be learned]

### Work Patterns
- [To be learned]

## Current Context

### Active Project
- **Name:** [Project name]
- **Stack:** [Technologies]
- **Status:** [Current phase]

### Key Files
- [To be discovered]

## Important Decisions

*Decisions will be logged as they're made*

## Learned Patterns

*Patterns will be captured from interactions*
```

### Daily Note Template
```markdown
# YYYY-MM-DD

## Summary
[Brief overview of the day's work]

## Sessions

### HH:MM - [Type]
[Session details]

## Key Learnings
- [What was learned]

## Pending Items
- [ ] [Items to follow up]
```

## Auto-Flush Protocol

When context window approaches 80% capacity:

1. **Trigger flush** before compaction
2. **Extract** key information from current context:
   - Decisions made
   - Preferences expressed
   - Important facts mentioned
3. **Write** to MEMORY.md
4. **Log** summary to daily notes
5. **Allow** compaction to proceed

## Memory Hygiene

### Do
- Update memory after learning something important
- Be specific and factual in entries
- Include dates for time-sensitive information
- Cross-reference related entries

### Don't
- Store sensitive credentials in memory files
- Log every trivial interaction
- Duplicate information across layers
- Let memory become stale without review

## Integration with Other Skills

### With skill-creator
When a new skill is created, log to memory:
```markdown
## Learned Patterns

### Skills Acquired
- **[skill-name]** (YYYY-MM-DD): [what it does]
```

### With heartbeat
During heartbeat checks, consult memory for:
- User's active hours and preferences
- Pending items that need attention
- Context for proactive actions

## Commands

- **"Remember this"** - Explicitly save current context to MEMORY.md
- **"What do you know about X"** - Retrieve from memory
- **"Update memory"** - Trigger consolidation
- **"Show memory"** - Display current MEMORY.md

## References
- See `AUTONOMOUS_BOOTUP_SPEC.md` for architecture
- See `skill-creator` for skill persistence
- See `heartbeat-manager` for scheduled memory tasks
