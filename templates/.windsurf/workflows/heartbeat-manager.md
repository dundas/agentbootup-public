<!-- AUTO-GENERATED from .claude/skills/heartbeat-manager/SKILL.md -->
# Heartbeat Manager

Configure and manage proactive heartbeat checks for autonomous operation..

## Input
See skill documentation

## Steps

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

## Output
See skill documentation

## Reference

Use @skills/heartbeat-manager/SKILL.md for detailed process documentation.
