# Design System Implementation

Implement or update frontend components and pages that strictly adhere to the project design system.

## Steps

1. Confirm the user wants to **build or modify UI that must follow the project design system**, such as:
   - A new page or screen.
   - A new component or variant.
   - Refactoring an existing view to match the design system.
2. Ask the user for context:
   - What they want built or changed (component/page/flow).
   - Where it lives in the codebase (file paths, routes, component names).
   - Any relevant technical constraints (framework, routing, data layer, accessibility requirements).
3. Check for the design system files:
   - Look for `design/design-system.json` (and `design/design.json` if present).
   - If not found, explain that this workflow expects a design system and suggest running the **Design System from Reference** workflow first.
4. Use `@skills/design-system-implementation/SKILL.md` to:
   - Load and summarize the relevant parts of the design system for this task (tokens, components, states, layout rules).
   - Break the requested UI into sections/components and map each to existing design system patterns.
   - Plan how to implement or update the UI using only the design system’s tokens and component recipes where possible.
5. Implement changes incrementally with `@skills/design-system-implementation/SKILL.md`:
   - Update or create components in small, reviewable steps.
   - After each significant change, pause to:
     - Show the updated code or diff.
     - Explain how it adheres to the design system (which tokens/variants are used, how spacing/typography match, etc.).
6. If new patterns or variants are needed:
   - Have the skill propose specific additions or changes to `design/design-system.json` as JSON snippets.
   - Present these to the user for approval **before** modifying the design system file.
7. Once the user is satisfied with the implementation:
   - Summarize what was built or changed and how it aligns with the design system.
   - Highlight any design system updates that were made or are recommended.
   - Suggest follow-up work (e.g., applying the same patterns to other screens, adding tests, or updating documentation).
