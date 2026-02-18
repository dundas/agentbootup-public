---
name: user-journey-mapper
description: Map user flows and journeys through your application for UX design and workflow visualization
---

# User Journey Mapper Command

Creates visual user journey maps that document how users flow through your application to accomplish their goals. Ideal for UX design, workflow documentation, and understanding user experience.

## Usage

```
/user-journey-mapper
```

## What It Does

1. Gathers context about feature, user goal, and entry points
2. Maps primary journey (happy path) with detailed stages
3. Documents alternate paths (different user types, scenarios)
4. Maps error journeys and recovery paths
5. Analyzes abandonment points and pain points
6. Adds UX insights and improvement opportunities
7. Creates Mermaid diagrams for visual flow representation

## Output

Creates `docs/journeys/[feature-name]-journey.md` with:
- Primary user journey with stage-by-stage breakdown
- Mermaid flow diagrams
- Alternate journeys (returning users, mobile vs desktop, etc.)
- Error scenarios and recovery paths
- UX insights (emotions, pain points, opportunities)
- Abandonment analysis

## When to Use

- **Designing new features** - Plan UX before implementation
- **Understanding existing flows** - Document how features currently work
- **Identifying UX problems** - Find friction points and drop-offs
- **Planning improvements** - Visualize before/after flows
- **Stakeholder communication** - Show how users experience features

## When NOT to Use

- **Need E2E test cases** - Use `/test-plan-generator` for QA testing
- **Need functional validation** - Use `/production-readiness` for launch checklist
- **Just need user stories** - Use `/user-story-generator` for backlog items

## Skill Reference

This command invokes: `@skills/user-journey-mapper`

See `@skills/user-journey-mapper/reference.md` for detailed examples.
