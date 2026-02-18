---
name: design-system-from-reference
description: Extract visual style from reference UI screenshot and codify into reusable design system.
category: design
---

# Skill: design-system-from-reference

## What this skill does

Guides Gemini CLI through a structured, four-phase workflow to extract a visual style from a reference UI screenshot and codify it into a reusable design system for this project. It:

- Produces `design/design.json` as a high-level style guide.
- Builds a local React + Vite + Tailwind 3 "showcase" app that implements all core components.
- Produces `design/design-system.json` as the implementation-level source of truth for future AI-assisted development.

This skill follows the rule defined in `ai-dev-tasks/design-system-from-reference.md`.

## When to use

Use this skill when:

- You have a **reference UI** (e.g., a design-system-style screenshot from Dribbble) and
- You want the project to adopt that look as a **consistent design system** that future features can follow.

It is especially useful early in a project, before large amounts of UI have been implemented.

## Inputs and assumptions

- The user can provide or attach at least one **flat design-system screenshot** (not angled or heavily decorated).
- The project can contain a `design/` folder at the repo root.
- The project can run a local React + Vite + Tailwind 3 app (Node and npm available).
- This project uses Markdown docs under `ai-dev-tasks/` and may already have other AI Dev Task rules.

Always confirm with the user before installing dependencies or running long-lived dev servers.

## High-level workflow

Follow these phases, coordinating with the user at each major step.

### Phase 1: Visual Inspiration & Analysis

1. Ask the user to:
   - Briefly describe the app this design system will serve (domain, platform, audience).
   - Attach or reference the primary **design-system-style screenshot**.
2. Verify the screenshot quality:
   - Flat (no heavy perspective).
   - Includes multiple components (buttons, inputs, cards, nav patterns, typography).
3. Summarize back the intended style and constraints (e.g., brand adjectives, tone) before proceeding.

### Phase 2: Create High-Level Style Guide (`design/design.json`)

1. Explain to the user that you will create `design/design.json` as a high-level style guide.
2. Using the best available **vision model**, deeply analyze the reference screenshot and generate `design/design.json` with:
   - Brand essence and key adjectives.
   - Color palette (primary, secondary, accents, neutrals, states).
   - Typography (families, weights, scales, usage rules).
   - Layout and spacing rules (grid, spacing scale, padding patterns).
   - Component-level guidelines (buttons, inputs, cards, navigation, alerts, tables, etc.).
   - Design principles, do's and don'ts.
3. Save or propose the JSON content to be written to `design/design.json` at the project root.
4. Show a short summary of the generated guide and ask the user to confirm or request edits. Apply any requested tweaks.

### Phase 3: Build the Showcase Application

1. Confirm with the user:
   - Where to place the showcase app (e.g., `design/showcase-app/`).
   - That using React + Vite + Tailwind 3 is acceptable.
2. Use the best available **coding model** to scaffold a small Vite + React app that:
   - Lives under the agreed folder (for example `design/showcase-app/`).
   - Uses Tailwind CSS v3 configured consistently with `design/design.json`.
3. Implement a single screen (or small set of screens) that showcases all core components:
   - Buttons (primary/secondary/tertiary, states).
   - Form controls (inputs, selects, textareas).
   - Cards, surfaces, and list items.
   - Navigation (top bar/side bar as appropriate).
   - Status components (badges, alerts, toasts).
4. Provide clear instructions to the user for running the app locally (e.g., `npm install`, `npm run dev` in the showcase folder) but never run commands or install dependencies without explicit confirmation.
5. Ask the user to visually review the running app and request specific adjustments (e.g., spacing, radii, shadows, color tweaks). Apply changes iteratively until the look closely matches the reference.

### Phase 4: Codify the System (`design/design-system.json`)

1. Once the showcase app feels correct, explain that you will codify the final system into `design/design-system.json`.
2. Analyze the actual implemented components and Tailwind classes in the showcase app and synthesize a comprehensive JSON file that includes:
   - Exact Tailwind utility recipes for each component variant.
   - Token-level spacing, radii, shadows, and typography scales.
   - State rules (hover, focus, active, disabled, error, success, etc.).
   - Motion/interaction patterns if present.
   - High-level guidelines and do's/don'ts for when to use each component.
3. Propose the full JSON for `design/design-system.json` and write it to `design/design-system.json` once the user approves.
4. Briefly document in natural language (inside the JSON or as comments if the project convention allows) how other agents should reference this file.

## Behavior in future sessions

When future prompts involve building or modifying UI in this project:

- Always check for the presence of `design/design-system.json` and `design/design.json`.
- If they exist, load them into context and follow them strictly when designing new screens or components.
- If they do not exist but the user references the design system workflow, suggest running this skill to establish the design system before proceeding.
