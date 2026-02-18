---
name: heartbeat-manager
description: Configure and manage proactive heartbeat checks for autonomous operation.
category: autonomous
---

# Heartbeat Manager

> **Important: Instruction Template**
> This skill provides a checklist and configuration format for Gemini CLI to follow.
> There is no automatic scheduler - heartbeat checks run only when Claude reads and
> follows this template during a session. For true automation, integrate with external
> schedulers (cron, systemd timers) that invoke Gemini CLI periodically.

## Goal
Enable proactive agent behavior through scheduled heartbeat checks that run without user prompting.

## Concept

A heartbeat is a periodic check that allows the agent to:
- Monitor for items requiring attention
- Take autonomous action on routine tasks
- Alert the user only when needed
- Maintain awareness of ongoing processes

**Key Principle:** Silence = all systems normal. Only notify when action is required.

## Heartbeat Configuration

### Location
`automation/HEARTBEAT.md` or `.agent/HEARTBEAT.md`

### Format
```markdown
# Heartbeat Configuration

## Schedule
- **Interval:** 30m
- **Active Hours:** 08:00 - 22:00
- **Timezone:** America/New_York

## Checks

### Communications
- [ ] Check email for urgent messages
- [ ] Review Slack/Discord for direct mentions
- [ ] Check GitHub notifications

### Monitoring
- [ ] Verify background jobs completed
- [ ] Check for CI/CD failures
- [ ] Monitor system alerts

### Proactive Tasks
- [ ] If idle > 2 hours with pending tasks, remind
- [ ] If PR approved, suggest merge
- [ ] If deadline approaching, alert

## Notification Rules
- **Urgent:** Notify immediately
- **Normal:** Batch and notify at next check
- **Low:** Log only, no notification
```

## Process

### Creating a Heartbeat

1. **Identify Monitoring Needs**
   - What should be checked periodically?
   - What requires user attention vs autonomous action?
   - What's the appropriate frequency?

2. **Define Checks**
   For each check, specify:
   - What to check
   - How to determine if action needed
   - What action to take (notify/act/log)

3. **Set Schedule**
   - Interval: How often to run (15m, 30m, 1h)
   - Active hours: When to run (respect user's schedule)
   - Timezone: For consistent timing

4. **Configure Notifications**
   - Where to deliver (chat, email, log)
   - Urgency levels and routing
   - Batching rules

### Running a Heartbeat

When heartbeat triggers:

1. **Load Configuration**
   Read HEARTBEAT.md for current checks

2. **Execute Checks**
   Run each check in the list:
   - Evaluate condition
   - Determine if action needed
   - Log result

3. **Process Results**
   - **Nothing to report:** Silent, log only
   - **Items found:** Compile notification
   - **Urgent items:** Immediate alert

4. **Deliver Notifications**
   If items require attention:
   ```
   🔔 Heartbeat Check (HH:MM)

   ## Requires Attention
   - [Item 1]
   - [Item 2]

   ## Completed Autonomously
   - [Action taken]
   ```

5. **Update Memory**
   Log heartbeat results to daily notes

## Example Configurations

### Developer Heartbeat
```markdown
# Developer Heartbeat

## Schedule
- **Interval:** 30m
- **Active Hours:** 09:00 - 18:00

## Checks

### Code Review
- [ ] PRs awaiting my review
- [ ] My PRs with new comments
- [ ] CI failures on my branches

### Tasks
- [ ] Blocked tasks that may be unblocked
- [ ] Approaching deadlines (< 24h)

### Communications
- [ ] Slack mentions in engineering channels
- [ ] GitHub @mentions

## Auto-Actions
- Mark stale PRs for follow-up
- Draft responses to simple questions
```

### Personal Assistant Heartbeat
```markdown
# Personal Assistant Heartbeat

## Schedule
- **Interval:** 1h
- **Active Hours:** 07:00 - 22:00

## Checks

### Calendar
- [ ] Upcoming meetings (next 2 hours)
- [ ] Meetings requiring prep
- [ ] Scheduling conflicts

### Email
- [ ] Urgent emails (VIP senders)
- [ ] Emails awaiting response > 24h

### Tasks
- [ ] Overdue items
- [ ] Items due today

## Auto-Actions
- Prepare meeting briefs
- Draft email responses for review
```

## Heartbeat vs Cron

| Feature | Heartbeat | Cron |
|---------|-----------|------|
| **Purpose** | Monitoring & checking | Scheduled execution |
| **Frequency** | Regular intervals | Specific times |
| **Output** | Notify if needed | Always execute task |
| **Context** | Shares main session | Can be isolated |
| **Best For** | Awareness tasks | Scheduled reports |

Use heartbeat for: "Check if X needs attention"
Use cron for: "Do Y at specific time"

## Commands

- **"Configure heartbeat"** - Set up or modify heartbeat
- **"Run heartbeat now"** - Execute immediate check
- **"Pause heartbeat"** - Temporarily disable
- **"Show heartbeat status"** - Display configuration and last run

## Integration

### With Memory Manager
- Log heartbeat results to daily notes
- Track patterns over time in MEMORY.md

### With Task Processor
- Check for tasks that can be progressed
- Alert on blocked or stale tasks

### With Communication Skills
- Check relevant channels
- Draft responses when appropriate

## Autonomous Action Guidelines

### May Act Autonomously
- Checking status of systems
- Logging information
- Preparing summaries
- Marking items for attention

### Must Ask First
- Sending external messages
- Modifying data
- Taking irreversible actions
- Spending money

## References
- See `AUTONOMOUS_BOOTUP_SPEC.md` for architecture
- See `memory-manager` for logging patterns
- See cron documentation for scheduled tasks
