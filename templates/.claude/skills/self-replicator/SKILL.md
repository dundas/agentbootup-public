---
name: self-replicator
description: Clone the agent to new environments with all learned skills and curated memory.
category: autonomous
---

# Self-Replicator

> **Important: Conceptual Skill**
> This skill describes patterns for replicating agent configurations across environments.
> Claude Code itself runs within terminal sessions and cannot self-deploy to remote servers.
> The "replication" here means exporting and copying instruction templates, skills, and
> memory files - not autonomous self-propagation.

## Goal
Create autonomous copies of the agent on new systems, preserving learned capabilities and relevant context.

## When to Use
- Setting up agent on a new machine
- Creating a dedicated agent for specific tasks
- Deploying to cloud/VPS for 24/7 operation
- Sharing agent configuration with team members

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

## Replication Modes

### Full Clone
Copies everything for identical capability:
- All skills
- All agents
- Full memory
- All automation

Use for: Backup, migration, redundancy

### Capability Clone
Copies specific capabilities:
- Selected skills only
- Relevant memory sections
- Targeted automation

Use for: Specialized deployments, team sharing

### Fresh Start with Skills
Copies skills but no memory:
- All learned skills
- Empty memory
- Default configuration

Use for: New projects, clean slate with capabilities

## Cloud Deployment

> **Conceptual Patterns**
> The following deployment patterns are conceptual examples for future autonomous agent
> architectures. They are not currently supported by Claude Code, which runs within
> terminal sessions rather than as a standalone daemon. These patterns may be relevant
> for custom agent implementations built on top of Claude's API.

### VPS Deployment (DigitalOcean, AWS, etc.)

1. **Provision Server**
   - Ubuntu 22.04+ recommended
   - 2GB RAM minimum
   - 20GB storage

2. **Install Dependencies**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

3. **Deploy Agent**
   ```bash
   npm install -g agent-cli
   # Copy export package
   # Configure credentials
   ```

4. **Set Up Service**
   ```bash
   # Create systemd service for auto-start
   sudo systemctl enable agent
   sudo systemctl start agent
   ```

5. **Configure Networking**
   - Set up firewall rules
   - Configure webhook endpoints if needed
   - Set up monitoring

### Container Deployment

```dockerfile
FROM node:22-slim

WORKDIR /agent
COPY export_package/ /root/.agent/

RUN npm install -g agent-cli

# Credentials via environment variables
ENV ANTHROPIC_API_KEY=""
ENV GITHUB_TOKEN=""

CMD ["agent", "start", "--daemon"]
```

## Security Considerations

### What to Transfer
- Skill definitions (safe, no secrets)
- Agent configurations (safe)
- Curated memory (review for sensitive info)
- Automation rules (safe)

### What NOT to Transfer
- API credentials (re-provide on target)
- Session data (ephemeral)
- Daily logs (may contain sensitive context)
- Local file paths (won't work on new system)

### Memory Sanitization
Before export, review MEMORY.md for:
- Personal information
- Credentials accidentally stored
- Sensitive business context
- Location-specific details

## Multi-Agent Networks

### Hub-and-Spoke Model
```
       ┌─────────┐
       │   Hub   │
       │ (Main)  │
       └────┬────┘
            │
    ┌───────┼───────┐
    │       │       │
┌───┴───┐ ┌─┴─┐ ┌───┴───┐
│ Clone │ │...│ │ Clone │
│   1   │ │   │ │   N   │
└───────┘ └───┘ └───────┘
```

- Hub coordinates high-level tasks
- Clones handle specialized work
- Shared skill registry
- Federated memory (clone-specific + shared)

### Peer Network
```
┌─────────┐     ┌─────────┐
│ Agent A │◄───►│ Agent B │
└────┬────┘     └────┬────┘
     │               │
     └───────┬───────┘
             │
        ┌────┴────┐
        │ Agent C │
        └─────────┘
```

- Agents share capabilities
- Skill propagation across network
- Distributed task handling

## Commands

- **"Prepare for replication"** - Create export package
- **"Clone to [target]"** - Deploy to specified target
- **"List clones"** - Show known clone instances
- **"Sync with clone"** - Share new skills/memory

## References
- See `AUTONOMOUS_BOOTUP_SPEC.md` for architecture
- See `skill-creator` for skill format
- See `memory-manager` for memory structure
