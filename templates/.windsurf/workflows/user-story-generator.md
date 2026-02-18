<!-- AUTO-GENERATED from .claude/skills/user-story-generator/SKILL.md -->
# User Story Generator

Generate standalone user stories for features without creating a full PRD. Perfect for backlog grooming and story refinement..

## Input
- **Feature description** - Verbal explanation of the feature
- **User type** - Who will use this feature
- **Goal** - What the user wants to accomplish

## Steps

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

## Output
- **Format:** Markdown (`.md`)
- **Location:** `docs/stories/`
- **Filename:** `[feature-name]-stories.md`

---

## Reference

Use @skills/user-story-generator/SKILL.md for detailed process documentation.
