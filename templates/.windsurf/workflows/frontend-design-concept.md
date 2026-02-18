# Frontend Design Concept

Create a bold, distinctive frontend implementation for a specific component, page, or flow using the `frontend-design-concept` skill.

## Steps

1. Confirm the user wants to **design or redesign a specific frontend surface**, such as:
   - A single component (e.g., pricing card, dashboard widget, navigation bar)
   - A full page or screen
   - A small, coherent flow (e.g., onboarding, checkout)
2. Ask the user for:
   - A clear description of the purpose, target users, and constraints (framework, tech stack, perf/accessibility needs).
   - Any reference material: brand guidelines, existing pages, moodboards, or example sites they like.
   - Whether this design should respect an existing design system:
     - If `design/design-system.json` exists, plan to load it and stay consistent with it.
3. Use `@skills/frontend-design-concept/SKILL.md` to:
   - Choose a **bold aesthetic direction** (e.g., brutalist, retro-futuristic, luxury, playful, editorial).
   - Propose the direction back to the user in 2–3 short options if needed, and confirm which to pursue.
   - Generate production-grade frontend code (React/HTML/etc.) with:
     - Strong typography choices
     - Cohesive color and theming
     - Motion and micro-interactions where appropriate
     - Intentional layout and visual details that avoid generic AI aesthetics
4. If a design system file exists (e.g., `design/design-system.json`), instruct the skill to:
   - Load and follow that system for tokens, spacing, and component patterns.
   - Use its rules as the baseline, while still making bold, context-appropriate aesthetic choices.
5. Present the initial implementation and **pause** for feedback:
   - Summarize the visual direction and key design decisions.
   - Highlight any trade-offs (e.g., more motion vs. simplicity, accessibility concerns).
   - Ask the user which aspects to tweak (layout, typography, color, motion, density).
6. Iterate with `@skills/frontend-design-concept/SKILL.md` to refine:
   - Apply requested tweaks in small, reviewable chunks.
   - Keep diffs focused and easy to understand (component by component or section by section).
7. Once the user is satisfied:
   - Summarize the final aesthetic direction and implementation details.
   - Call out any new patterns or components that should be folded back into the project’s design system (if one exists).
   - Suggest next steps (e.g., extracting shared components, updating `design/design-system.json`, or applying the style to additional screens).
