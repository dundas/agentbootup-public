---
name: skill-creator
description: Create new skills from learned capabilities, enabling self-bootstrapping and permanent skill acquisition.
category: autonomous
---

# Skill Creator

## Goal
Transform any newly learned capability into a permanent, reusable skill that persists across sessions.

## When to Use
- After successfully completing a new type of task
- When user asks to "remember how to do this"
- When you've built a useful automation or integration
- After learning a new API or tool

## Process

### Step 1: Identify the Capability
Analyze what was just accomplished:
- What problem did this solve?
- What inputs were required?
- What outputs were produced?
- What steps were involved?

### Step 2: Generalize the Pattern
Abstract from the specific instance:
- Remove hardcoded values
- Identify variable inputs
- Document decision points
- Note error handling patterns

### Step 3: Create Skill Structure
```
skills/<skill-name>/
├── SKILL.md          # Main skill definition
└── reference.md      # Examples and detailed docs (optional)
```

### Step 4: Write SKILL.md
Use this template:
```yaml
---
name: skill-name-here
description: One-line description of what this skill does.
---

# Skill Name

## Goal
Clear statement of what this skill accomplishes.

## Process
1. First step of the process
2. Second step
3. Continue until complete

## Inputs
- Input one: description
- Input two: description

## Outputs
- Output one: description
- Where outputs are saved

## Key Principles
- Important rules
- Things to always/never do

## References
- Related skills or documentation
```

### Step 5: Save and Register
- Save to `skills/<skill-name>/SKILL.md`
- For project-specific: `.agent/skills/`
- For global: `~/.agent/skills/`

### Step 6: Announce Acquisition
Tell the user:
```
"I've created a new skill: [skill-name]

This skill allows me to [capability description].

I can now do this anytime - it's permanently saved.

To use it: [trigger phrase or command]"
```

## Skill Quality Checklist

Before saving, verify:
- [ ] Goal is clear and specific
- [ ] Process steps are actionable
- [ ] Inputs are well-defined
- [ ] Outputs are specified
- [ ] No hardcoded values that should be parameters
- [ ] Error cases are handled
- [ ] Can be understood by another agent

## Example: Creating an API Integration Skill

After successfully integrating with a new API:

```yaml
---
name: weather-api
description: Fetch weather data from OpenWeatherMap API.
---

# Weather API Integration

## Goal
Retrieve current weather and forecasts for any location.

## Process
1. Receive location (city name or coordinates)
2. Authenticate with API key from credentials
3. Call appropriate endpoint (current/forecast)
4. Parse response into structured data
5. Return formatted weather information

## Inputs
- Location: city name, zip code, or lat/lon
- Type: "current" or "forecast"
- Units: "metric" or "imperial" (default: metric)

## Outputs
- Temperature, conditions, humidity, wind
- For forecast: 5-day hourly breakdown
- Formatted for display or further processing

## Key Principles
- Cache responses for 10 minutes to avoid rate limits
- Handle API errors gracefully with retry
- Always include units in output
```

## Self-Bootstrapping Pattern

This skill enables the autonomous agent loop:

```
┌─────────────────────────────────────────┐
│                                         │
│   User Request                          │
│        ↓                                │
│   Agent Attempts                        │
│        ↓                                │
│   Success? ─── No ──→ Research & Build  │
│        │                     ↓          │
│       Yes               Test & Iterate  │
│        │                     ↓          │
│        └────────────────────┘           │
│                 ↓                       │
│        [SKILL-CREATOR]                  │
│                 ↓                       │
│        Permanent Skill                  │
│                 ↓                       │
│        Announce Capability              │
│                                         │
└─────────────────────────────────────────┘
```

## References
- See `AUTONOMOUS_BOOTUP_SPEC.md` for full architecture
- See `memory-manager` skill for persistence patterns
