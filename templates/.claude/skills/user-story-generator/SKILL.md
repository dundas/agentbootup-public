---
name: user-story-generator
description: Generate standalone user stories for features without creating a full PRD. Perfect for backlog grooming and story refinement.
category: documentation
---

# User Story Generator

## Goal
Generate well-formed user stories with acceptance criteria for features, without requiring a full PRD. Ideal for quick backlog items, story refinement sessions, or exploring feature ideas.

## Input
- **Feature description** - Verbal explanation of the feature
- **User type** - Who will use this feature
- **Goal** - What the user wants to accomplish

## Output
- **Format:** Markdown (`.md`)
- **Location:** `docs/stories/`
- **Filename:** `[feature-name]-stories.md`

---

## Process

### Phase 1: Context Gathering

1. **Ask Clarifying Questions**

   ```
   I'll help generate user stories for [feature name].

   Quick questions:
   1. Who is the primary user? (customer, admin, developer, etc.)
   2. What is the main goal or problem this solves?
   3. Are there different user types with different needs?
   4. Any specific edge cases or error scenarios to consider?
   5. Any acceptance criteria you already have in mind?
   ```

2. **Identify User Types**

   Determine all user personas that interact with this feature:
   - Primary users (who benefits most)
   - Secondary users (indirect beneficiaries)
   - Admin/support users (management perspective)

### Phase 2: Generate User Stories

3. **Generate Primary User Stories**

   For each major user action, create a story:

   ```markdown
   ## User Story: [Action/Feature Name]

   **As a** [user type]
   **I want** [specific action]
   **So that** [clear benefit/outcome]

   **Priority:** High | Medium | Low

   **Acceptance Criteria:**
   - [ ] [Specific, testable criterion 1]
   - [ ] [Specific, testable criterion 2]
   - [ ] [Edge case or error handling]

   **Out of Scope:**
   - [What this story explicitly does NOT include]

   **Dependencies:**
   - [Other stories, features, or services needed]

   **Notes:**
   - [Additional context, technical considerations, or design notes]
   ```

4. **Generate Edge Case Stories**

   Don't forget error scenarios:
   - What happens when things go wrong?
   - How do users recover from errors?
   - What validation is needed?

5. **Generate Admin/Support Stories**

   If applicable, add stories for:
   - Managing the feature (configuration, settings)
   - Monitoring and troubleshooting
   - Support team needs

### Phase 3: Add Acceptance Criteria

6. **Define Testable Criteria**

   For each story, ensure acceptance criteria are:
   - **Specific:** Not vague like "it works"
   - **Measurable:** Has clear expected outcome
   - **Testable:** Can be verified by QA or developer
   - **User-focused:** Describes behavior, not implementation

   **Good examples:**
   - ✅ "User sees confirmation message within 2 seconds"
   - ✅ "Error message shows when email is invalid format"
   - ✅ "Search returns results sorted by relevance"

   **Bad examples:**
   - ❌ "System processes request" (too vague)
   - ❌ "API returns 200" (implementation detail)
   - ❌ "It works correctly" (not measurable)

7. **Add Story Metadata**

   Include for each story:
   - **Priority** (High/Medium/Low) based on user value
   - **Dependencies** (what must exist first)
   - **Out of Scope** (what this specifically doesn't do)
   - **Notes** (design considerations, technical constraints)

### Phase 4: Review & Save

8. **Present Draft to User**
   ```
   I've generated [N] user stories for [feature name]:
   - [N] primary user stories
   - [N] edge case stories
   - [N] admin/support stories

   Each story includes:
   - User story format (As a/I want/So that)
   - Priority
   - Acceptance criteria
   - Dependencies and notes

   Review before I save.
   ```

9. **Save User Stories**
   Save to `docs/stories/[feature-name]-stories.md`

10. **Summarize Next Steps**
    ```
    User stories created at: docs/stories/[feature-name]-stories.md

    Next steps:
    1. Review and refine with product owner
    2. Add story point estimates (if using)
    3. Add to backlog or sprint planning
    4. Use as input for task-list generation (if building now)
    5. Create PRD if more detail is needed
    ```

---

## Output Format Template

```markdown
# User Stories: [Feature Name]

**Generated:** YYYY-MM-DD
**Feature Owner:** [Name or team]
**Status:** Draft | Refined | Ready for Development

---

## Overview

**Feature:** [Brief 1-2 sentence description]
**User Impact:** [Who benefits and how]
**Goal:** [Primary objective]

---

## User Stories

### 1. [Story Title - Primary Action]

**As a** [user type]
**I want** [action]
**So that** [benefit]

**Priority:** High | Medium | Low

**Acceptance Criteria:**
- [ ] [Criterion 1]
- [ ] [Criterion 2]
- [ ] [Criterion 3]

**Out of Scope:**
- [What this doesn't include]

**Dependencies:**
- [Other story or feature]

**Notes:**
- [Design considerations]
- [Technical constraints]

---

### 2. [Story Title - Edge Case]

[Repeat format]

---

### 3. [Story Title - Admin/Support]

[Repeat format]

---

## Story Summary

| # | Story | User Type | Priority | Dependencies |
|---|-------|-----------|----------|--------------|
| 1 | [Short title] | [User] | High | None |
| 2 | [Short title] | [User] | Medium | Story 1 |

**Total Stories:** N
**High Priority:** N | **Medium:** N | **Low:** N

---

## Next Steps

- [ ] Review stories with product owner
- [ ] Add story point estimates
- [ ] Prioritize for sprint planning
- [ ] Add to backlog
- [ ] Consider creating full PRD if needed

---

*User stories generated by agentbootup user-story-generator skill*
```

---

## Key Principles

- **User-Focused:** Every story starts with "As a [user]"
- **Actionable:** Stories describe what users do, not how system works
- **Independent:** Each story can be understood and implemented separately
- **Testable:** Acceptance criteria are specific and verifiable
- **No Implementation Details:** Focus on behavior, not code
- **No Arbitrary Timeframes:** Priority and complexity, not time estimates

---

## When to Use

Use **user-story-generator** when:
- ✅ Quick backlog grooming
- ✅ Story refinement sessions
- ✅ Exploring feature ideas without full PRD
- ✅ Breaking down epic into smaller stories
- ✅ Adding stories to existing backlog

Use **prd-writer** instead when:
- ❌ Need comprehensive feature documentation
- ❌ Require technical architecture details
- ❌ Need design mockups and UI specifications
- ❌ Multiple features or complex project

---

## Integration with Other Skills

- **Before prd-writer:** Generate stories first, then expand into full PRD
- **Before tasklist-generator:** Stories can be input for task breakdown
- **Before production-readiness:** Stories become acceptance criteria for launch
- **After brainstorming:** Capture feature ideas as user stories

---

## Differences from PRD Writer

| Aspect | user-story-generator | prd-writer |
|--------|---------------------|------------|
| **Output** | Standalone user stories | Full PRD document |
| **Detail** | Stories + criteria only | Stories + goals + design + tech specs |
| **Use case** | Quick backlog items | Comprehensive feature spec |
| **Time** | 5-10 minutes | 30-60 minutes |
| **Audience** | Dev team, product owner | Entire team + stakeholders |

---

## Target Audience

- Product owners doing backlog grooming
- Developers breaking down features
- Teams in story refinement sessions
- Anyone exploring feature ideas quickly
