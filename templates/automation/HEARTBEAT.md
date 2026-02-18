# Heartbeat Configuration

*Proactive monitoring and autonomous actions*

---

## Schedule

- **Interval:** 30m
- **Active Hours:** 08:00 - 22:00
- **Timezone:** America/New_York
- **Target:** last (deliver to most recent conversation)

---

## Checks

### 📧 Communications

- [ ] **Email:** Check for urgent messages (VIP senders, keywords: urgent, critical, ASAP)
- [ ] **Slack/Discord:** Review direct mentions and DMs
- [ ] **GitHub:** Check notifications for PR reviews, mentions, assignment

### 📋 Tasks & Projects

- [ ] **Pending Tasks:** Any tasks blocked for >24h that may be unblocked?
- [ ] **Deadlines:** Items due within 24 hours?
- [ ] **Stale PRs:** PRs open >3 days without activity?

### 🔧 Development

- [ ] **CI/CD:** Any failed pipelines on watched branches?
- [ ] **PRs Ready:** Approved PRs ready to merge?
- [ ] **Review Requests:** PRs awaiting my review?

### 📊 Monitoring

- [ ] **Background Jobs:** Any long-running tasks completed?
- [ ] **Errors:** New errors in logs?
- [ ] **Resources:** Any resource alerts?

---

## Autonomous Actions

*Actions the agent may take without asking*

### May Do Automatically
- ✅ Check status of systems and services
- ✅ Log information to daily notes
- ✅ Prepare summaries and briefings
- ✅ Mark items for attention
- ✅ Draft responses for review

### Must Ask First
- ❌ Send external communications
- ❌ Merge or deploy code
- ❌ Delete or modify important data
- ❌ Make purchases or financial transactions
- ❌ Create public posts or comments

---

## Notification Rules

### Urgency Levels

| Level | Criteria | Action |
|-------|----------|--------|
| 🔴 **Critical** | System down, security issue | Immediate notification |
| 🟠 **Urgent** | Blocking issue, deadline today | Notify within 5 min |
| 🟡 **Normal** | Requires attention | Include in next heartbeat |
| 🟢 **Low** | Informational | Log only |

### Batching
- Batch non-urgent items into single notification
- Group by category (comms, tasks, dev)
- Suppress if nothing to report (silence = good)

---

## Notification Format

When items require attention:

```
🔔 Heartbeat Check (HH:MM)

## 🔴 Critical
[Critical items if any]

## 🟠 Requires Attention
- [Item 1]
- [Item 2]

## ✅ Completed Autonomously
- [Action taken 1]
- [Action taken 2]

## 📊 Status
- Pending tasks: N
- Upcoming deadlines: N
- Unread messages: N
```

---

## Conditional Checks

### If Idle > 2 Hours
- Check if pending tasks exist
- Gently remind about current work
- Suggest next action

### If End of Day Approaching
- Summarize day's accomplishments
- List items for tomorrow
- Suggest wrap-up actions

### If Monday Morning
- Weekly summary of previous week
- Priorities for the week
- Upcoming deadlines

---

## Custom Checks

*Add project-specific checks below*

### [Project Name]
- [ ] [Custom check 1]
- [ ] [Custom check 2]

---

## Configuration

### Enable/Disable
```
heartbeat:
  enabled: true
  interval: "30m"
  active_hours:
    start: "08:00"
    end: "22:00"
    timezone: "America/New_York"
```

### Channel-Specific Settings
```
notifications:
  critical: immediate
  urgent: next_check
  normal: batch
  low: log_only
```

---

*Heartbeat managed by heartbeat-manager skill*
*Edit this file to customize monitoring behavior*
