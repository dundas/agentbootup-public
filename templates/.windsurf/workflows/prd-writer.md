# PRD Writer
Create a clear, actionable PRD with clarifying questions and junior-friendly structure.

## Steps
1. Ask the user to describe the feature and optionally @-mention reference files.
2. Use @skills/prd-writer/SKILL.md to ask clarifying questions first (provide multiple-choice options).
3. Generate the PRD with the required sections: Overview, Goals, User Stories, Functional Requirements, Non-Goals, Design/Technical considerations, Success Metrics, Open Questions.
4. Propose filename and confirm save path:
   - /tasks/[n]-prd-[feature-name].md (n is zero-padded, e.g., 0001)
5. Save the PRD and show a short summary of sections included.
