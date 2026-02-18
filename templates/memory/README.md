# Memory System

This directory contains the autonomous memory system for continuous learning and improvement.

## Structure

```
memory/
├── README.md              # This file
├── MEMORY.md              # Core knowledge (always consulted)
└── daily/
    ├── TEMPLATE.md        # Daily log template
    └── YYYY-MM-DD.md     # Daily session logs
```

## Usage

### Session Start
At the beginning of each session, read:
1. `memory/MEMORY.md` - Core operational knowledge
2. `memory/daily/<today>.md` - Today's session log (if exists)

### During Session
- Document significant learnings in real-time
- Record technical decisions with reasoning
- Track new patterns discovered

### Session End
Update memory with:
1. Session summary
2. Technical decisions made
3. Learnings discovered
4. Files modified
5. Next steps

## Memory Files

### MEMORY.md
**Purpose**: Long-term operational knowledge

**Content**:
- Core identity and purpose
- Operational protocols
- Project context
- Critical learnings
- Skills acquired
- Standing orders

**Maintenance**:
- Keep under 200 lines
- Link to detailed docs for deep topics
- Update after discovering new patterns
- Remove outdated information

### daily/YYYY-MM-DD.md
**Purpose**: Detailed session history

**Content**:
- Session summary
- Key activities
- Technical decisions
- Learnings
- Blockers
- Next steps
- Files modified

**Maintenance**:
- Create new file each day
- Use TEMPLATE.md for structure
- Be specific and detailed
- Include code examples

## CLI-Agnostic Design

This memory system works with any AI coding assistant:
- **Claude Code**: Automatically loaded via hooks
- **Gemini CLI**: Automatically loaded via hooks
- **Cursor**: Manually reference in session
- **Windsurf**: Manually reference in session
- **Other**: Read at session start

## Best Practices

**Do**:
- ✅ Consult memory before responding
- ✅ Update memory after learning
- ✅ Document decisions with rationale
- ✅ Keep MEMORY.md concise
- ✅ Be specific in daily logs

**Don't**:
- ❌ Store temporary info in MEMORY.md
- ❌ Skip decision rationale
- ❌ Forget to update after learning
- ❌ Let MEMORY.md exceed 200 lines

## Integration

### With Native Task Systems
- **Claude Code**: Use TaskCreate, TaskUpdate, TaskList
- **Gemini CLI**: Use Gemini's task system (if available)
- **Fallback**: Use WORKQUEUE.md in memory/ directory

### With Skills
- Skills are stored in `.ai/skills/` or CLI-specific locations
- Skills reference memory for context
- Memory tracks acquired skills

## Troubleshooting

**Issue**: Memory not loading
- Check file exists: `ls memory/MEMORY.md`
- Check permissions: `ls -la memory/`
- For CLI with hooks, check hooks are installed

**Issue**: MEMORY.md too long
- Move detailed content to separate docs
- Link to deep-dive docs instead
- Archive superseded information

**Issue**: Lost context between sessions
- Ensure daily logs are being created
- Check MEMORY.md has latest learnings
- Consider enabling sync (if available)

## More Information

See `.ai/skills/` for:
- `skill-acquisition/` - How to build new skills
- `memory-manager/` - Automated memory management

See `.ai/protocols/` for:
- Autonomous operation protocols
- Decision-making frameworks
- Phase gate processes
