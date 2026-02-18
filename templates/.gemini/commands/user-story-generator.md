---
name: user-story-generator
description: Generate standalone user stories for features without creating a full PRD
---

# User Story Generator Command

Generates well-formed user stories with acceptance criteria for features, without requiring a full PRD. Ideal for quick backlog items, story refinement sessions, or exploring feature ideas.

## Usage

```
/user-story-generator
```

## What It Does

1. Asks clarifying questions about the feature
2. Identifies primary and secondary user types
3. Generates user stories in "As a/I want/So that" format
4. Creates specific, testable acceptance criteria
5. Adds priority levels and dependencies
6. Includes edge cases and error scenarios

## Output

Creates `docs/stories/[feature-name]-stories.md` with:
- User stories in standard format
- Priority levels (High/Medium/Low)
- Acceptance criteria per story
- Dependencies and out-of-scope notes
- Story summary table

## When to Use

- **Quick backlog grooming** - Add stories without full PRD overhead
- **Story refinement sessions** - Break down epics into stories
- **Exploring feature ideas** - Test concepts before full planning
- **Sprint planning** - Generate implementable stories quickly

## When NOT to Use

- **Need full PRD** - Use `/prd-writer` for comprehensive specs
- **Need technical architecture** - Use `/prd-writer` for design details
- **Need UX flows** - Use `/user-journey-mapper` for journey mapping

## Skill Reference

This command invokes: `@skills/user-story-generator`

See `@skills/user-story-generator/reference.md` for detailed examples.
