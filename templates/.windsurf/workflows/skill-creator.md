<!-- AUTO-GENERATED from .claude/skills/skill-creator/SKILL.md -->
# Skill Creator

Create new skills from learned capabilities, enabling self-bootstrapping and permanent skill acquisition..

## Input
See skill documentation

## Steps

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

## Output
See skill documentation

## Reference

Use @skills/skill-creator/SKILL.md for detailed process documentation.
