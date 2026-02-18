<!-- AUTO-GENERATED from .claude/skills/user-journey-mapper/SKILL.md -->
# Rule: User Journey Mapper

## Goal

Create visual user journey maps that document how users flow through your application to accomplish their goals. Ideal for UX design, workflow documentation, and understanding user experience before or after implementation.

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

---

*This is an auto-generated reference. For full documentation with examples, see `.claude/skills/user-journey-mapper/SKILL.md` and `reference.md`.*
