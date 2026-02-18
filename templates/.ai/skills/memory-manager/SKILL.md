# Memory Manager

**Purpose**: Manage persistent memory across sessions through automated learning capture at key lifecycle events.

## When to Use

This skill is **automatically triggered** at:
- Session start (read memory)
- Session end (update memory)
- After significant learning
- After creating new skills
- After completing major tasks

User can also manually invoke:
- "Update memory with this learning"
- "Log this to daily notes"
- "Add this to permanent knowledge"

## Workflow

### Automatic: Session Start
1. Read `memory/MEMORY.md` for context
2. Check `memory/daily/YYYY-MM-DD.md` for today's log
3. Review `~/.teleportation/workspace/WORKQUEUE.md` for pending work
4. Load relevant skill documentation

### Automatic: Session End
1. Summarize significant activities
2. Document technical decisions made
3. Log learnings discovered
4. Update MEMORY.md if new patterns emerged
5. Write to `memory/daily/YYYY-MM-DD.md`

### Manual: Capture Learning
1. Identify the learning (pattern, pitfall, decision)
2. Determine if it's:
   - **Temporary**: Add to daily log only
   - **Permanent**: Add to MEMORY.md
3. Update appropriate file
4. Ensure MEMORY.md stays under 200 lines

### Manual: Add Skill to Memory
1. Read newly created skill documentation
2. Add to "Skills Acquired" section in MEMORY.md
3. Log creation details to daily log
4. Update skill count

## Memory File Structure

### MEMORY.md
**Purpose**: Long-term operational knowledge

**Sections**:
1. Core Identity
2. Operational Protocols
3. Project Context
4. Critical Learnings
5. Skills Acquired
6. Standing Orders

**Maintenance**:
- Keep under 200 lines
- Link to detailed docs for deep topics
- Update after discovering new patterns
- Remove outdated information

### daily/YYYY-MM-DD.md
**Purpose**: Detailed session history

**Sections**:
1. Session Summary
2. Key Activities
3. Technical Decisions
4. Learnings
5. Blockers
6. Next Steps
7. Files Modified

**Maintenance**:
- Create new file each day
- Use TEMPLATE.md for structure
- Be specific and detailed
- Include code examples when relevant

## Decision Framework

### When to Update MEMORY.md

**Add to MEMORY.md if**:
- ✅ Pattern applies to multiple scenarios
- ✅ Critical for system operation
- ✅ Prevents future mistakes
- ✅ Changes how we work

**Keep in daily log if**:
- ❌ One-time occurrence
- ❌ Context-specific detail
- ❌ Temporary workaround
- ❌ Already documented elsewhere

### Memory Pruning

When MEMORY.md approaches 200 lines:
1. Identify content that's become outdated
2. Move detailed examples to separate docs
3. Link to deep-dive docs instead of inline
4. Archive superseded information

## Examples

### Example: Logging Technical Decision

**Daily Log Entry**:
```markdown
## Technical Decisions

### ✅ Use Encrypted Credentials for API Keys
**Reasoning**: Security requirement - credentials must never be committed to git.

**Options considered**:
- ✅ Encrypted credential file (chosen - secure, portable)
- ❌ Environment variables only (rejected - not portable)
- ❌ System keychain only (rejected - platform-specific)

**Implementation**: Created CredentialManager class with AES-256 encryption.

**Files**: `lib/auth/credentials.js`, `lib/auth/credentials.test.js`
```

### Example: Adding to Permanent Knowledge

**MEMORY.md Update**:
```markdown
## Critical Learnings

### Security
- **Credential storage**: Use CredentialManager with AES-256 encryption
- **File permissions**: Credential files must be 600 (owner read/write only)
- **Git safety**: Never commit files from ~/.teleportation/ directory
```

### Example: Session End Summary

**Daily Log Entry**:
```markdown
# Daily Log - 2026-02-05

## Session Summary
**Focus**: Implementing self-improvement capabilities

## Key Activities
- Created memory system (MEMORY.md + daily logs)
- Added autonomous protocols to CLAUDE.md
- Built skill-acquisition workflow
- Integrated learning hooks

## Learnings
### Autonomous Operation
- Clear decision-making boundaries prevent analysis paralysis
- Memory must be consulted before responding and updated after learning
- Skills should be tested thoroughly before permanent storage

## Next Steps
1. Test memory system with real sessions
2. Validate automatic memory updates
3. Create additional foundational skills
```

## Integration Points

### Hook Integration
The memory manager integrates with Claude Code hooks:

**session_start.mjs**:
```javascript
// Read memory at session start
const memoryPath = path.join(process.cwd(), 'memory/MEMORY.md');
const memory = await fs.readFile(memoryPath, 'utf-8');
// Context is available for Claude's first turn
```

**session_end.mjs**:
```javascript
// Update daily log at session end
const today = new Date().toISOString().split('T')[0];
const logPath = path.join(process.cwd(), `memory/daily/${today}.md`);
// Append session summary
```

**stop.mjs**:
```javascript
// Capture learnings after significant work
// Update memory if new patterns emerged
```

### WORKQUEUE.md Integration

Memory complements the work queue:

**WORKQUEUE.md** (short-term):
- Current focus
- Pending tasks
- Blocked items

**MEMORY.md** (long-term):
- Patterns and principles
- Critical knowledge
- Permanent capabilities

## Quality Checklist

Before updating memory:

- [ ] Learning is significant (not trivial)
- [ ] Clearly documented with examples
- [ ] Categorized appropriately (Security, Patterns, etc.)
- [ ] Won't become outdated quickly
- [ ] Actually useful for future sessions

Before completing session:

- [ ] Daily log has session summary
- [ ] Technical decisions documented
- [ ] Learnings captured
- [ ] Next steps identified
- [ ] Files modified listed

## Common Pitfalls

- **Issue**: MEMORY.md becomes too long
  - **Solution**: Move detailed content to reference docs, keep only key points

- **Issue**: Daily logs are too brief
  - **Solution**: Include code examples, decision rationale, specific file paths

- **Issue**: Forgetting to update memory
  - **Solution**: Make it part of session end routine

- **Issue**: Storing temporary info in MEMORY.md
  - **Solution**: Use daily logs for session-specific details

## Maintenance

### Weekly
- Review week's daily logs
- Identify recurring patterns
- Promote important learnings to MEMORY.md
- Prune outdated MEMORY.md content

### Monthly
- Archive old daily logs
- Refactor MEMORY.md structure
- Validate links to reference docs
- Clean up skills list

## Related Skills

- `skill-acquisition` - Creates new skills, updates memory
- `autonomous-improver` - Uses memory for continuous improvement
- `dev-workflow-orchestrator` - Leverages memory for workflow decisions
