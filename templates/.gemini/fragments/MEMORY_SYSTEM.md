## Autonomous Memory System

This project uses the agentbootup self-improvement system for continuous learning and autonomous operation.

### Memory Files (Always Consult)

**At session start, read**:
1. `memory/MEMORY.md` - Core operational knowledge and protocols
2. `memory/daily/<today>.md` - Today's session log (if exists)

**At session end, update**:
1. `memory/daily/<today>.md` - Session summary, decisions, learnings
2. `memory/MEMORY.md` - New permanent patterns (if discovered)

### Autonomous Operation Protocols

See `.ai/protocols/AUTONOMOUS_OPERATION.md` for complete protocols including:
- Decision-making authority (what to act on vs ask about)
- Phase gate protocol (when to pause for confirmation)
- Error handling protocol (fix immediately, never defer)
- Skill acquisition protocol (building permanent capabilities)
- Memory management protocol (what/when/how to update)

### Key Principles

**Decision-Making**:
- ✅ Act autonomously on: technical choices, testing, documentation, memory updates
- ❌ Ask for input on: destructive actions, external communications, strategic direction

**Communication Style**:
- Be decisive, not deferential
- State decisions with reasoning
- Signal confidence levels
- Silence = normal operation

**Error Handling**:
- Fix issues immediately
- Never mark tasks complete with caveats
- Test until it actually works
- Update memory with lessons learned

**Phase Gates**:
- Complete each phase fully
- Pause at major transitions
- Wait for explicit "Go" or "yes"
- No partial work left behind

### Skills System

**Location**: `.ai/skills/` (CLI-agnostic) or `.gemini/skills/` (Gemini-specific)

**Core Skills**:
- `skill-acquisition/` - Systematic skill building workflow
- `memory-manager/` - Automated memory management

**Creating New Skills**:
1. **Phase 0**: Check existing skills first (MANDATORY)
2. Only build if no existing skill covers the capability
3. Use skill-acquisition workflow for structured creation

### Task Management

**Use Gemini CLI tasks** (if available) or `WORKQUEUE.md` for task tracking.

**Coordinate with memory**:
- Tasks = tactical execution
- WORKQUEUE.md = strategic direction
- Memory = long-term knowledge

### Standing Orders

Execute continuously without being asked:

1. Check memory at session start
2. Monitor system health proactively
3. Learn continuously - update memory after significant interactions
4. Build skills permanently for novel challenges (check existing first!)
5. Pause at phase gates
6. Test before completion
7. Act proactively on routine items
8. Ask before destructive actions
9. Document decisions in daily logs
10. Fix issues immediately
