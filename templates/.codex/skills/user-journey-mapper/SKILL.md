---
name: user-journey-mapper
description: Map user flows and journeys through your application for UX design and workflow visualization, independent of testing.
category: documentation
---

# User Journey Mapper

## Goal
Create visual user journey maps that document how users flow through your application to accomplish their goals. Ideal for UX design, workflow documentation, and understanding user experience before or after implementation.

## Input
- **Feature description** - What the feature does
- **User goal** - What users want to accomplish
- **Entry point** - Where users start (homepage, email link, etc.)

## Output
- **Format:** Markdown (`.md`) with Mermaid diagrams
- **Location:** `docs/journeys/`
- **Filename:** `[feature-name]-journey.md`

---

## Process

### Phase 1: Context Gathering

1. **Ask Journey Questions**

   ```
   I'll help map the user journey for [feature name].

   Questions:
   1. Where does the user start? (homepage, email, notification, etc.)
   2. What is their end goal? (complete purchase, send message, etc.)
   3. Are there different paths to the same goal?
   4. What are common distractions or exit points?
   5. Any existing user flow diagrams or wireframes?
   ```

2. **Identify Journey Stages**

   Map the typical journey stages:
   - **Awareness:** How do users discover this feature?
   - **Entry:** Where do they enter the flow?
   - **Engagement:** What actions do they take?
   - **Conversion:** What's the success action?
   - **Exit:** How do they leave (success, abandon, error)?

### Phase 2: Map Primary Journey

3. **Document Happy Path**

   Map the ideal, successful user journey:

   ```markdown
   ## Primary Journey: [Goal Name]

   **User Goal:** [What user wants to accomplish]
   **Entry Point:** [Where they start]
   **Success Outcome:** [What success looks like]

   ### Journey Steps

   1. **[Stage 1 Name]** - [Page/Screen Name]
      - **User Action:** [What user does]
      - **System Response:** [What happens]
      - **User Sees:** [What's displayed]
      - **Next:** [Where they go next]

   2. **[Stage 2 Name]** - [Page/Screen Name]
      - **User Action:** [What user does]
      - **System Response:** [What happens]
      - **User Sees:** [What's displayed]
      - **Next:** [Where they go next]

   [Continue for all stages...]

   ### Journey Diagram

   \`\`\`mermaid
   graph TD
       A[Entry Point] --> B[Stage 1]
       B --> C[Stage 2]
       C --> D[Stage 3]
       D --> E[Success!]
   \`\`\`
   ```

4. **Add Touchpoints**

   For each stage, document:
   - **UI Elements:** Buttons, forms, links
   - **Data Displayed:** What information user sees
   - **User Emotions:** Confident, confused, frustrated, delighted
   - **Time Spent:** Typical duration at each stage (if known)

### Phase 3: Map Alternative Paths

5. **Document Alternate Journeys**

   Map common variations:
   - **New user vs returning user**
   - **Mobile vs desktop**
   - **Different user permissions/roles**
   - **Feature variations (A/B tests)**

   ```markdown
   ## Alternate Journey: [Variation Name]

   **Difference from Primary:** [How it differs]
   **When This Occurs:** [Conditions]

   ### Journey Diagram

   \`\`\`mermaid
   graph TD
       A[Entry] --> B{User Type?}
       B -->|New| C[Onboarding]
       B -->|Returning| D[Skip to Main]
       C --> E[Success]
       D --> E
   \`\`\`
   ```

### Phase 4: Map Error & Edge Cases

6. **Document Error Paths**

   Map what happens when things go wrong:

   ```markdown
   ## Error Journeys

   ### 1. [Error Scenario Name]

   **Trigger:** [What causes this error]
   **User Impact:** [How user is affected]

   **Recovery Path:**
   1. User sees error message: "[Message text]"
   2. User can: [Action options]
   3. System: [What happens]
   4. Result: [Back to happy path or exit]

   \`\`\`mermaid
   graph TD
       A[Action] -->|Error| B[Error Message]
       B --> C{User Choice}
       C -->|Retry| A
       C -->|Cancel| D[Exit]
   \`\`\`
   ```

7. **Map Abandonment Points**

   Identify where users typically exit:
   - **High friction points** (complex forms, slow loading)
   - **Confusion points** (unclear next step)
   - **Blockers** (missing info, errors)

   ```markdown
   ## Abandonment Analysis

   ### Common Exit Points

   1. **[Stage Name]** - [Location]
      - **Why:** [Reason users abandon]
      - **Frequency:** High | Medium | Low
      - **Prevention:** [How to reduce abandonment]
   ```

### Phase 5: Add UX Insights

8. **Document User Experience**

   For each journey stage, add:

   ```markdown
   ## UX Insights

   ### [Stage Name]

   **User Emotion:** 😊 Delighted | 😐 Neutral | 😟 Frustrated
   **Complexity:** Simple | Moderate | Complex
   **Common Questions:** [What users wonder at this stage]
   **Pain Points:** [What causes friction]
   **Opportunities:** [How to improve]
   ```

9. **Add Metrics (if available)**

   Include analytics data if known:
   - **Conversion rate:** % who complete journey
   - **Drop-off rate:** % who abandon at each stage
   - **Time spent:** Average duration per stage
   - **Success rate:** % who achieve goal

### Phase 6: Review & Save

10. **Present Draft to User**
    ```
    I've mapped the user journey for [feature name]:
    - Primary journey ([N] stages)
    - [N] alternate paths
    - [N] error scenarios
    - UX insights for each stage

    Review before I save.
    ```

11. **Save Journey Map**
    Save to `docs/journeys/[feature-name]-journey.md`

12. **Summarize Next Steps**
    ```
    User journey map created at: docs/journeys/[feature-name]-journey.md

    Next steps:
    1. Review with UX designer and product owner
    2. Identify opportunities for improvement
    3. Use as input for wireframes/mockups
    4. Reference when creating test plans
    5. Update as feature evolves
    ```

---

## Output Format Template

```markdown
# User Journey: [Feature Name]

**Generated:** YYYY-MM-DD
**Feature:** [Brief description]
**Primary User:** [User type]

---

## Overview

**User Goal:** [What user wants to accomplish]
**Entry Points:** [How users discover/start]
**Success Outcome:** [What success looks like]
**Typical Duration:** [If known, how long journey takes]

---

## Primary Journey: [Goal Name]

### Journey Steps

#### 1. [Stage Name] - [Page/Screen]

**User Action:** [What they do]
**System Response:** [What happens]
**User Sees:** [What's displayed]
**User Emotion:** 😊 | 😐 | 😟
**Next Step:** [Where they go]

**UI Elements:**
- [Button/link name]
- [Form fields]
- [Navigation]

**Pain Points:**
- [Any friction or confusion]

**Opportunities:**
- [Ways to improve this stage]

---

[Repeat for each stage]

---

### Journey Diagram

\`\`\`mermaid
graph TD
    A[Entry Point] --> B[Stage 1: Discover]
    B --> C[Stage 2: Engage]
    C --> D[Stage 3: Act]
    D --> E[Stage 4: Confirm]
    E --> F[Success!]

    C -.->|Error| G[Error Handler]
    G --> C

    style F fill:#90EE90
    style G fill:#FFB6C1
\`\`\`

---

## Alternate Journeys

### Returning User Path

**Difference:** Skips onboarding, has saved preferences
**When:** User has account and is logged in

\`\`\`mermaid
graph TD
    A{User Type?} -->|New| B[Full Onboarding]
    A -->|Returning| C[Skip to Main]
    B --> D[Main Flow]
    C --> D
\`\`\`

---

## Error Journeys

### 1. [Error Scenario]

**Trigger:** [What causes error]
**User Impact:** [How user affected]

**Recovery:**
1. Error message shown
2. User can [action]
3. System [response]

---

## Abandonment Analysis

### Common Exit Points

| Stage | Exit Rate | Reason | Prevention |
|-------|-----------|--------|------------|
| [Stage] | High/Med/Low | [Why] | [How to reduce] |

---

## UX Insights

### Overall Journey

**Strengths:**
- [What works well]

**Pain Points:**
- [What causes friction]

**Opportunities:**
- [How to improve]

### Metrics (if available)

- **Completion Rate:** X%
- **Average Duration:** X minutes
- **Drop-off Points:** [List stages]

---

## Next Steps

- [ ] Review with UX team
- [ ] Create wireframes for key stages
- [ ] Identify quick wins for UX improvements
- [ ] Set up analytics tracking for journey stages
- [ ] Plan A/B tests for optimization

---

*User journey map generated by agentbootup user-journey-mapper skill*
```

---

## Key Principles

- **User-Centric:** Focus on user actions and emotions, not system internals
- **Visual:** Use Mermaid diagrams to show flow clearly
- **Complete:** Include happy path, alternatives, and errors
- **Actionable:** Identify pain points and opportunities
- **Honest:** Document real user experience, not ideal scenario
- **No Arbitrary Timeframes:** Show sequence and dependencies, not schedules

---

## When to Use

Use **user-journey-mapper** when:
- ✅ Designing new feature UX
- ✅ Understanding existing user flows
- ✅ Identifying UX pain points
- ✅ Planning UX improvements
- ✅ Documenting workflows for stakeholders

Use **test-plan-generator** instead when:
- ❌ Need E2E test cases with steps
- ❌ Validating feature functionality
- ❌ Creating QA test documentation
- ❌ Tracking bugs and issues

---

## Integration with Other Skills

- **Before prd-writer:** Map journey first, then write requirements
- **Before test-plan-generator:** Journey informs test scenarios
- **After user-story-generator:** Visualize how stories connect in user flow
- **With UX design:** Use as input for wireframes and prototypes

---

## Differences from Test Plan Generator

| Aspect | user-journey-mapper | test-plan-generator |
|--------|---------------------|---------------------|
| **Purpose** | UX design and workflow documentation | Feature E2E testing |
| **Focus** | User experience and flow | Functionality and validation |
| **Output** | Journey maps with diagrams | Test cases with steps |
| **Audience** | UX designers, product owners | QA engineers, developers |
| **When** | Before/during design | After implementation |
| **Includes** | Emotions, pain points, opportunities | Prerequisites, smoke tests, issue tracking |

---

## Target Audience

- UX designers planning user experience
- Product owners understanding user needs
- Developers implementing user flows
- Stakeholders visualizing how feature works
- Marketing understanding customer journey
