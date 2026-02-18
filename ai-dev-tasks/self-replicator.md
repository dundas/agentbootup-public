<!-- AUTO-GENERATED from .claude/skills/self-replicator/SKILL.md -->
# Rule: Self Replicator

## Goal

Create autonomous copies of the agent on new systems, preserving learned capabilities and relevant context.

## Output

See documentation

## Process

### Step 1: Prepare Export Package

Gather exportable components:

```
export_package/
├── skills/                 # All learned skills
│   └── <skill>/SKILL.md
├── agents/                 # Agent definitions
│   └── <agent>.md
├── memory/
│   └── MEMORY.md          # Curated knowledge (not daily logs)
├── automation/
│   ├── HEARTBEAT.md       # Heartbeat configuration
│   └── cron/              # Scheduled tasks
└── config.json            # Agent configuration (no secrets)
```

**Exclude:**
- Daily notes (session-specific)
- Credentials (must be re-provided)
- Session files (ephemeral)
- Project-specific context (unless replicating for same project)

### Step 2: Prepare Target Environment

Requirements for target:
- Compatible runtime (Node.js 22+, Python 3.11+, etc.)
- Network access for API calls
- Sufficient storage for memory
- Appropriate permissions

### Step 3: Deploy Package

1. **Install Agent Runtime**
   ```bash
   # Example for different platforms
   npm install -g agent-cli
   # or
   pip install agent-cli
   # or
   brew install agent-cli
   ```

2. **Copy Export Package**
   ```bash
   # Copy to agent home
   cp -r export_package/* ~/.agent/
   ```

3. **Configure Credentials**
   User must provide API keys for:
   - Primary LLM provider
   - Any integrated services
   - Communication channels

### Step 4: Initialize Clone

1. **Load Configuration**
   - Read config.json
   - Verify settings

2. **Import Skills**
   - Load all skill definitions
   - Verify dependencies

3. **Import Memory**
   - Load MEMORY.md
   - Initialize daily notes for new environment

4. **Configure Automation**
   - Set up heartbeat
   - Register cron jobs
   - Adjust for new timezone if needed

### Step 5: Verify Operation

Run verification checks:
- [ ] Agent responds to basic queries
- [ ] Memory context is loaded
- [ ] Skills are accessible
- [ ] Automation is scheduled
- [ ] API integrations work

### Step 6: Handoff

Inform original instance:
```
Clone successfully deployed to [target].

Transferred:
- [N] skills
- [N] agent definitions
- Memory context (MEMORY.md)
- Heartbeat configuration

Clone is now operating independently.
```

---

*This is an auto-generated reference. For full documentation with examples, see `.claude/skills/self-replicator/SKILL.md` and `reference.md`.*
