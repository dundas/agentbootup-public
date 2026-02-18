# Design System from Reference

Create a reusable design system for this project from a reference UI screenshot.

## Steps

1. Confirm the user wants to establish or update the project-wide design system.
2. Ask the user to:
   - Briefly describe the product and target platform.
   - Attach or reference a **design-system-style screenshot** (flat image showing multiple components, not a heavy perspective shot).
3. Open and review `@ai-dev-tasks/design-system-from-reference.md` to align on the four-phase workflow (visual analysis → `design/design.json` → showcase app → `design/design-system.json`).
4. Use `@skills/design-system-from-reference/SKILL.md` to:
   - Analyze the reference screenshot and generate `design/design.json` under `/design/`.
   - Scaffold a small React + Vite + Tailwind 3 showcase app (e.g., under `/design/showcase-app/`) that implements all core components.
   - Iterate with the user on visual tweaks until the showcase closely matches the reference.
   - Extract the final implementation into `design/design-system.json` under `/design/`.
5. At each major phase (after `design/design.json`, after the initial showcase, after `design/design-system.json`), pause and:
   - Summarize what was created.
   - Show example snippets (JSON excerpts, component screenshots or descriptions).
   - Ask the user to confirm or request adjustments before proceeding.
6. At the end of the workflow, summarize:
   - Where the files live (`design/design.json`, `design/design-system.json`, showcase app folder).
   - How future AI assistants should reference them (e.g., always `@design/design-system.json` when building UI).
   - Any follow-up actions (e.g., integrating components from the showcase app into the main codebase).
