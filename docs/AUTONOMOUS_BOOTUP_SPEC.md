# Autonomous Agent Bootup Specification v1.0

**A standardized instruction set for bootstrapping any CLI into an autonomous, self-improving AI agent**

---

## Executive Summary

This specification defines the patterns, file structures, and operational protocols required to transform any AI-powered CLI into an autonomous agent capable of:

- **Persistent Memory** - Remembering context across sessions indefinitely
- **Self-Bootstrapping Skills** - Learning new capabilities and saving them permanently
- **Proactive Automation** - Operating autonomously via heartbeats and scheduled tasks
- **Multi-Agent Orchestration** - Coordinating specialized sub-agents for complex workflows
- **Tool Acquisition** - Integrating new APIs and extending capabilities on-demand

Based on analysis of emerging autonomous agent architectures (OpenClaw/Moltbot/Clawdbot) and production workflow patterns.

---

## Table of Contents

1. [Core Architecture](#core-architecture)
2. [Directory Structure](#directory-structure)
3. [Memory System](#memory-system)
4. [Skill System](#skill-system)
5. [Agent System](#agent-system)
6. [Automation & Heartbeat](#automation--heartbeat)
7. [Workflow Orchestration](#workflow-orchestration)
8. [Self-Bootstrapping Protocol](#self-bootstrapping-protocol)
9. [Security Considerations](#security-considerations)
10. [Implementation Checklist](#implementation-checklist)

---

## Core Architecture

### The Autonomous Agent Loop

```
┌─────────────────────────────────────────────────────────────────┐
│                    AUTONOMOUS AGENT LOOP                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐       │
│   │   INPUT     │───▶│   PROCESS   │───▶│   OUTPUT    │       │
│   │  Channels   │    │   Gateway   │    │   Actions   │       │
│   └─────────────┘    └─────────────┘    └─────────────┘       │
│         │                   │                   │               │
│         ▼                   ▼                   ▼               │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐       │
│   │  Heartbeat  │    │   Memory    │    │   Skills    │       │
│   │  Scheduler  │◀──▶│   System    │◀──▶│   Registry  │       │
│   └─────────────┘    └─────────────┘    └─────────────┘       │
│         │                   │                   │               │
│         └───────────────────┼───────────────────┘               │
│                             ▼                                   │
│                    ┌─────────────────┐                         │
│                    │  SELF-BOOTSTRAP │                         │
│                    │  (Learn & Save) │                         │
│                    └─────────────────┘                         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Key Principles

1. **Skills are Permanent** - Once learned, a capability persists forever
2. **Memory is Layered** - Short-term (daily), long-term (curated), and semantic (searchable)
3. **Automation is Proactive** - Agent acts without prompting via heartbeats
4. **Agents are Specialized** - Different agents for different task types
5. **Everything is Composable** - Skills, agents, and workflows combine freely

---

## Directory Structure

### Workspace Layout

```
~/.agent/                           # Global agent home
├── config.json                     # Agent configuration
├── credentials/                    # API keys and tokens (encrypted)
│   ├── anthropic.enc
│   ├── openai.enc
│   └── ...
├── memory/                         # Memory persistence
│   ├── MEMORY.md                   # Long-term curated knowledge
│   ├── daily/                      # Daily conversation logs
│   │   ├── 2026-02-03.md
│   │   └── ...
│   └── embeddings/                 # Semantic search index
├── skills/                         # Global skills (all projects)
│   └── <skill-name>/
│       ├── SKILL.md
│       └── reference.md
├── agents/                         # Agent definitions
│   └── <agent-name>.md
├── automation/                     # Scheduled tasks
│   ├── HEARTBEAT.md               # Periodic check configuration
│   └── cron/                      # Scheduled jobs
└── sessions/                       # Session state
    ├── sessions.json
    └── <session-id>.jsonl

<project>/                          # Project workspace
├── .agent/                         # Project-specific overrides
│   ├── CLAUDE.md                   # Project instructions
│   ├── skills/                     # Project-specific skills
│   ├── agents/                     # Project-specific agents
│   └── tasks/                      # Generated task lists
└── ...
```

### Configuration File (`config.json`)

```json
{
  "agent": {
    "name": "assistant",
    "model": "anthropic/claude-opus-4-5",
    "fallback_models": [
      "anthropic/claude-sonnet-4",
      "openai/gpt-5.2"
    ]
  },
  "memory": {
    "daily_notes": true,
    "long_term": true,
    "semantic_search": true,
    "auto_flush_threshold": 0.8
  },
  "automation": {
    "heartbeat_enabled": true,
    "heartbeat_interval": "30m",
    "active_hours": {
      "start": "08:00",
      "end": "22:00",
      "timezone": "America/New_York"
    }
  },
  "skills": {
    "auto_discover": true,
    "registries": [
      "https://registry.example.com/skills"
    ]
  },
  "security": {
    "sandbox_mode": false,
    "require_approval": ["shell", "file_write", "network"],
    "blocked_commands": ["rm -rf /", "sudo"]
  }
}
```

---

## Memory System

### Three-Layer Architecture

#### Layer 1: Daily Notes (`memory/daily/YYYY-MM-DD.md`)

Raw conversation logs, automatically captured:

```markdown
# 2026-02-03

## 09:15 - User Session

**User:** Help me set up authentication for the API
**Agent:** I'll help you implement JWT-based authentication...

[Full conversation transcript]

## 14:30 - Heartbeat Check

- Checked email: 3 new messages, none urgent
- Calendar: Meeting at 3pm with Design team
- GitHub: PR #42 has 2 approving reviews, ready to merge
```

#### Layer 2: Long-Term Memory (`memory/MEMORY.md`)

Curated, distilled knowledge:

```markdown
# Agent Memory

## User Preferences

- **Code Style:** Prefers TypeScript over JavaScript
- **Testing:** Always write tests first (TDD approach)
- **Communication:** Brief responses, no unnecessary verbosity
- **Work Hours:** Usually active 9am-6pm EST

## Project Context

### Current Project: E-commerce Platform
- **Stack:** Bun, React, PostgreSQL
- **Key Files:** `src/api/`, `src/components/`, `src/db/`
- **Active PRD:** `tasks/0003-prd-payment-integration.md`

## Important Decisions

- 2026-01-28: Chose Stripe over PayPal for payment processing (lower fees)
- 2026-02-01: Decided to use Redis for session storage (performance)

## Learned Patterns

- User prefers conventional commits with scope
- Always run tests before committing
- Use `bun` instead of `node` for all operations
```

#### Layer 3: Semantic Index (`memory/embeddings/`)

Vector embeddings for semantic search:

```json
{
  "index_version": "1.0",
  "embedding_model": "text-embedding-3-small",
  "chunks": [
    {
      "id": "mem_001",
      "text": "User prefers TypeScript over JavaScript",
      "source": "MEMORY.md",
      "embedding": [0.123, -0.456, ...]
    }
  ]
}
```

### Memory Operations

#### Auto-Flush Protocol

When context window approaches limits (80% threshold):

1. Trigger silent memory flush turn
2. Extract key decisions, preferences, and context
3. Write to `MEMORY.md`
4. Summarize and compact older conversation
5. Continue with reduced context

#### Memory Retrieval

```python
# Hybrid search: semantic + keyword
def retrieve_memory(query):
    # Semantic search for conceptual matches
    semantic_results = vector_search(query, top_k=5)

    # Keyword search for exact matches (error codes, file names)
    keyword_results = bm25_search(query, top_k=5)

    # Merge and deduplicate
    return merge_results(semantic_results, keyword_results)
```

---

## Skill System

### Skill Definition Format (`SKILL.md`)

```yaml
---
name: skill-name
description: One-line description of what this skill does.
version: 1.0.0
triggers:
  - keyword: "create prd"
  - keyword: "write requirements"
dependencies:
  - prd-writer
  - tasklist-generator
env:
  - GITHUB_TOKEN
  - OPENAI_API_KEY
---

# Skill Name

## Goal
Clear statement of what this skill accomplishes.

## Process
1. Step one of the process
2. Step two of the process
3. etc.

## Inputs
- What the skill expects from the user/context

## Outputs
- What the skill produces
- Where outputs are saved

## Interaction Model
- When to pause for user confirmation
- What approvals are required

## Key Principles
- Important rules and constraints
- Things to always/never do

## References
- See `reference.md` for detailed examples
- See related skills/agents
```

### Skill Categories

| Category | Purpose | Examples |
|----------|---------|----------|
| **Development** | Code writing, testing, refactoring | tdd-developer, code-reviewer |
| **Planning** | Requirements, task breakdown | prd-writer, tasklist-generator |
| **Automation** | Scheduled tasks, monitoring | heartbeat-manager, cron-job |
| **Integration** | External services, APIs | github-manager, slack-notifier |
| **Research** | Information gathering, analysis | web-researcher, doc-analyzer |
| **Communication** | Messaging, notifications | email-composer, channel-poster |

### Skill Installation

```bash
# From registry
agent skill install github-manager

# Manual (copy to skills directory)
cp -r my-skill/ ~/.agent/skills/

# Project-specific
cp -r my-skill/ .agent/skills/
```

### Skill Precedence

1. **Project skills** (`.agent/skills/`) - Highest priority
2. **Global skills** (`~/.agent/skills/`)
3. **Bundled skills** (shipped with agent)

---

## Agent System

### Agent Definition Format

```yaml
---
name: agent-name
description: What this agent specializes in
model: inherit  # or specific model like "claude-opus-4-5"
---

# Role
You are a [specialized role]. Always [key behavior].

## Inputs
- What this agent receives
- Context it needs

## Process
1. First step
2. Second step
3. etc.

## Outputs
- What this agent produces
- Artifacts it creates

## Rules
- Constraints and guidelines
- Things to always/never do

## Commit Guidance (if applicable)
- When and how to commit changes

## References
- Related agents and skills
```

### Standard Agent Types

#### tdd-developer
```yaml
# Implements features using test-driven development
# Red → Green → Refactor cycle
# Small, incremental commits
```

#### reliability-engineer
```yaml
# Handles safety-critical features
# Error handling, validation, edge cases
# Security-sensitive code
```

#### decomposition-architect
```yaml
# Breaks down goals into task DAGs
# Identifies dependencies and critical path
# Plans only, never implements
```

#### production-validator
```yaml
# Validates features are production-ready
# End-to-end testing verification
# No caveats or deferred issues
```

### Multi-Agent Orchestration

```markdown
## Agent Coordination Protocol

1. **Orchestrator** receives high-level goal
2. Orchestrator invokes **decomposition-architect** for planning
3. Plan presented to user for approval
4. For each task:
   - **tdd-developer** implements standard features
   - **reliability-engineer** handles safety-critical code
   - **production-validator** verifies completion
5. **Orchestrator** manages handoffs and state
```

---

## Automation & Heartbeat

### Heartbeat Configuration (`automation/HEARTBEAT.md`)

```markdown
# Heartbeat Checklist

## Every 30 Minutes

### Communications
- [ ] Check email for urgent messages (sender contains "urgent" or "critical")
- [ ] Review Slack for direct mentions
- [ ] Check GitHub notifications for PR reviews needed

### Monitoring
- [ ] Verify all scheduled jobs completed successfully
- [ ] Check for any failed CI/CD pipelines
- [ ] Monitor system resources (if threshold exceeded, alert)

### Proactive Tasks
- [ ] If idle > 2 hours and pending tasks exist, remind user
- [ ] If PR has been approved, suggest merging
- [ ] If daily notes exceed 5000 words, trigger memory consolidation

## Configuration

- **Interval:** 30m
- **Active Hours:** 08:00 - 22:00 EST
- **Target:** last (deliver to most recent conversation)
- **Silent When:** All checks pass (no news is good news)
```

### Cron Jobs (`automation/cron/`)

```yaml
# morning-briefing.yaml
name: "Morning Briefing"
schedule: "0 7 * * *"  # 7 AM daily
timezone: "America/New_York"
session: isolated
model: opus
deliver:
  channel: telegram
  to: "@username"
message: |
  Generate my morning briefing:
  1. Weather forecast
  2. Calendar summary for today
  3. Unread emails requiring action
  4. GitHub PRs awaiting review
  5. Any tasks I should prioritize
```

### Automation Patterns

| Pattern | Use Case | Mechanism |
|---------|----------|-----------|
| **Periodic Check** | Monitor email, Slack | Heartbeat |
| **Scheduled Report** | Daily briefing, weekly summary | Cron |
| **Event-Driven** | PR merged → deploy | Webhook/Trigger |
| **Idle Action** | Remind after inactivity | Heartbeat condition |

---

## Workflow Orchestration

### Phase-Gated Workflow

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Phase 1    │────▶│   Phase 2    │────▶│   Phase 3    │
│  PRD Writer  │     │ Task Gen     │     │ Task Process │
└──────────────┘     └──────────────┘     └──────────────┘
       │                    │                    │
       ▼                    ▼                    ▼
   [PAUSE]              [PAUSE]              [PAUSE]
   User: "Go"           User: "Go"           User: "yes"
```

### Orchestration Protocol

```markdown
## Development Workflow Orchestrator

### Phase 1: PRD Creation
1. Invoke `prd-writer` skill
2. Ask clarifying questions
3. Generate PRD
4. Save to `/tasks/[n]-prd-[feature].md`
5. **PAUSE** - Present PRD and wait for "Go"

### Phase 2: Task Generation
1. Invoke `tasklist-generator` skill
2. Read the PRD
3. Generate parent tasks only
4. **PAUSE** - Present parent tasks and wait for "Go"
5. Expand into sub-tasks with full metadata
6. Save to `/tasks/tasks-[prd-name].md`
7. **PAUSE** - Confirm task list

### Phase 3: Task Processing
1. Invoke `task-processor` skill
2. Process ONE sub-task at a time
3. Mark complete when:
   - Implementation works
   - Tests pass
   - End-to-end verified
   - No blocking issues
4. **PAUSE** - Wait for "yes" before next sub-task
5. When parent complete: commit and create PR

### Critical Rules
- Never proceed without explicit user approval
- Fix issues in-place, never defer
- Keep "Relevant Files" section accurate
- Use conventional commits with scope
```

---

## Self-Bootstrapping Protocol

### The Self-Improvement Loop

```
User Request → Agent Attempts → Success/Failure
                                      │
                    ┌─────────────────┴─────────────────┐
                    ▼                                   ▼
               [SUCCESS]                           [FAILURE]
                    │                                   │
                    ▼                                   ▼
            Save as Skill                      Research Solution
                    │                                   │
                    ▼                                   ▼
            Add to Registry                    Build New Skill
                    │                                   │
                    └─────────────────┬─────────────────┘
                                      ▼
                              [CAPABILITY ACQUIRED]
                              (Permanent, Reusable)
```

### Skill Acquisition Protocol

When user requests a new capability:

1. **Check Existing Skills**
   ```
   Does a skill already exist for this? → Use it
   ```

2. **Research & Build**
   ```
   - Search documentation, APIs, examples
   - Build proof-of-concept implementation
   - Test the implementation
   - Iterate until working
   ```

3. **Formalize as Skill**
   ```markdown
   # Create SKILL.md
   - Define clear goal
   - Document the process
   - Specify inputs/outputs
   - Add error handling
   - Include usage examples
   ```

4. **Save & Register**
   ```
   - Save to ~/.agent/skills/<skill-name>/
   - Add to skill registry
   - Update memory with new capability
   ```

5. **Announce Acquisition**
   ```
   "I've learned how to [capability]. This is now saved as a
   permanent skill and I can do this anytime in the future."
   ```

### Tool Integration Pattern

```markdown
## Adding a New API Integration

### Step 1: Acquire Credentials
User provides API key → Store in credentials/ (encrypted)

### Step 2: Learn the API
- Fetch documentation
- Understand endpoints and authentication
- Identify common use cases

### Step 3: Build Skill
```yaml
---
name: new-service-integration
description: Interact with NewService API
env:
  - NEW_SERVICE_API_KEY
---

# NewService Integration

## Capabilities
- Create items
- List items
- Update items
- Delete items

## Process
[Document API interaction patterns]
```

### Step 4: Test & Validate
- Run test operations
- Verify error handling
- Confirm rate limiting

### Step 5: Announce
"I can now interact with NewService. Try asking me to
[list of capabilities]."
```

### Self-Replication Protocol

For creating new agent instances:

```markdown
## Replication Steps

1. **Prepare Package**
   - Export current skills
   - Export curated memory (not daily logs)
   - Export agent configurations
   - Export automation rules

2. **Deploy to Target**
   - Install agent runtime on target system
   - Copy skills to ~/.agent/skills/
   - Copy agents to ~/.agent/agents/
   - Configure credentials (user provides)

3. **Initialize Clone**
   - Load memory context
   - Activate skills
   - Configure automation
   - Verify connectivity

4. **Handoff**
   - Confirm clone is operational
   - Share knowledge of replication
   - Clone can now operate independently
```

---

## Security Considerations

### Credential Management

```markdown
## Security Practices

### Never
- Store credentials in plain text
- Commit credentials to git
- Log API keys or tokens
- Share credentials between projects without explicit approval

### Always
- Use encrypted credential storage
- Require explicit approval for credential access
- Rotate credentials periodically
- Audit credential usage

### Sandboxing
- Run untrusted skills in isolated environment
- Limit file system access to workspace
- Require approval for network operations
- Block dangerous shell commands
```

### Permission Escalation

```yaml
# Required approvals for sensitive operations
require_approval:
  - shell_execute        # Any shell command
  - file_write_outside   # Writing outside workspace
  - network_external     # External API calls
  - credential_access    # Using stored credentials
  - agent_spawn         # Creating new agent instances
```

### Audit Logging

```markdown
## Audit Log Format

[2026-02-03 14:30:22] SKILL_INVOKE: prd-writer
[2026-02-03 14:30:45] FILE_WRITE: /tasks/0001-prd-auth.md
[2026-02-03 14:31:02] SHELL_EXECUTE: git status (approved: auto)
[2026-02-03 14:31:15] CREDENTIAL_ACCESS: GITHUB_TOKEN (approved: user)
[2026-02-03 14:31:20] NETWORK: api.github.com (approved: auto)
```

---

## Implementation Checklist

### Phase 1: Foundation

- [ ] Create directory structure (`~/.agent/`)
- [ ] Implement configuration loading (`config.json`)
- [ ] Build basic memory system (daily notes)
- [ ] Create skill loader (SKILL.md parser)
- [ ] Implement agent definitions loader

### Phase 2: Core Features

- [ ] Implement long-term memory (MEMORY.md)
- [ ] Add semantic search capability
- [ ] Build auto-flush/compaction
- [ ] Create heartbeat scheduler
- [ ] Implement cron job runner

### Phase 3: Self-Bootstrapping

- [ ] Skill acquisition protocol
- [ ] Tool integration framework
- [ ] API credential manager
- [ ] Skill registry system
- [ ] Self-improvement loop

### Phase 4: Orchestration

- [ ] Multi-agent coordination
- [ ] Phase-gated workflows
- [ ] Task dependency management
- [ ] Approval/confirmation gates
- [ ] Progress persistence

### Phase 5: Security & Polish

- [ ] Encrypted credential storage
- [ ] Permission system
- [ ] Audit logging
- [ ] Sandbox mode
- [ ] Error recovery

---

## Quick Start Template

To bootstrap a new project with autonomous agent capabilities:

```bash
# 1. Create project structure
mkdir -p .agent/{skills,agents,tasks}

# 2. Create CLAUDE.md with project instructions
cat > .agent/CLAUDE.md << 'EOF'
# Project Instructions

## Overview
[Describe your project]

## Tech Stack
[List technologies]

## Conventions
[Coding standards, commit format, etc.]

## Available Skills
- prd-writer: Create product requirements
- tasklist-generator: Break down PRDs into tasks
- task-processor: Implement tasks one at a time

## Workflow
Use `/dev-pipeline` to run the full PRD → Tasks → Implementation workflow.
EOF

# 3. Initialize memory
cat > .agent/MEMORY.md << 'EOF'
# Project Memory

## Context
[Project context and key decisions]

## Preferences
[User/team preferences]
EOF

# 4. Ready to go!
# The agent will now use project context and can learn new skills
```

---

## Inspiration & Conceptual References

> **Note:** This specification is inspired by emerging autonomous agent patterns observed in the AI community. The following references represent the conceptual foundations and community discussions that informed this design. Some URLs may be illustrative examples of the pattern rather than active links.

- **OpenClaw/Moltbot/Clawdbot** - Open-source autonomous agent architecture patterns
- **Agent Skills Pattern** - Community-driven skill sharing and discovery
- **MCP (Model Context Protocol)** - Anthropic's protocol for AI tool integration
- **Persistent Memory Architectures** - Patterns for cross-session context retention

---

*Specification Version: 1.0.0*
*Generated: 2026-02-03*
*Based on: OpenClaw architecture analysis and agentbootup patterns*
