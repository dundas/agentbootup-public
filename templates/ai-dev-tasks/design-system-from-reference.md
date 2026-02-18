# Rule: Creating a Design System from a Reference UI

## Goal

The goal of this workflow is to move beyond generic "AI-looking" interfaces by extracting a specific visual style from a reference UI and codifying it into a reusable design system that AI coding tools can reliably follow. The result is a pair of JSON design guides plus a small showcase application that proves the system in real code.

## Output

- **Format:**
  - `design/design.json` — high-level style guide derived from a reference screenshot.
  - `design/design-system.json` — codified, implementation-level system based on the verified Tailwind/React app.
  - Local React + Vite + Tailwind 3 "showcase" app that implements all core components.
- **Location:**
  - JSON files under the `/design/` directory at the project root.
  - Showcase app in a local folder chosen by the assistant (for example `/design/showcase-app/`).

## Process

### Phase 1: Visual Inspiration & Analysis

**Process:**
1. Go to a design inspiration site such as Dribbble.
2. Search for **"Design System"** (not just random UI screens).
3. Use the following selection criteria:
   - Find a "flat" screenshot showing multiple UI components (buttons, inputs, cards, typography).
   - **Avoid:** angled/perspective shots, cluttered images, or designs with decorative elements (like dashed borders) that you do not want the AI to copy.
   - **Goal:** a clear, clean image where components are distinct and easy for a vision model to parse.

### Phase 2: Create High-Level Style Guide (`design/design.json`)

**Goal:** Extract the overall vibe, colors, and high-level rules into a structured format that an AI coding tool can understand and reuse.

- **Model:** GPT-4o / GPT-5 (best available vision model).
- **Action:** Open a new agent chat, paste the selected screenshot, and run the following prompt.

**Prompt:**
```markdown
> Deeply analyze the design of the attached screenshot to create a design/design.json file in this project that describes the style and design of every component needed in a design system at a high level, like a creative director. Capture high-level guidelines for structure, spacing, fonts, colors, design style, and design principles so I can use this file as the design guidelines for my app. The goal with this file is to instruct AI to be able to replicate this look easily in a project.
```

**Result:** A `design/design.json` file containing values for brand essence, color palettes, typography, and design principles.

### Phase 3: Build the Showcase Application

**Goal:** Validate the style by building a real implementation of the components using Tailwind and React.

- **Model:** Claude 3.5 Sonnet (best available coding model).
- **Action:** Start a new agent (fresh context). Ensure `design/design.json` is available in context (for example via `@design/design.json`).

**Prompt:**
```markdown
> Let's create a simple screen that contains every UI component that would exist in a design system on a mock dashboard following the design style outlined in design/design.json. Build this as a Vite app using React and translate all styling into Tailwind version 3. Just run this locally.
```

**Result:** A running React/Vite app showcasing buttons, cards, navbars, inputs, alerts, and other core components.
- **Review phase:**
  - Open the app in the browser and inspect each component.
  - Ask the assistant to tweak specific components as needed (for example, "Fix the padding on the primary button" or "Adjust the card shadow to be softer").
  - Only move to the next phase once the showcase feels faithful to the original reference.

### Phase 4: Codify the System (`design/design-system.json`)

**Goal:** Create the master source of truth based on the actual code that was just built and verified.

- **Model:** GPT-4o / GPT-5 (best available synthesis model).
- **Action:** Start a new agent, point it at the code for the showcase app and the existing `design/design.json`, and run the following prompt.

**Prompt:**
```markdown
> In this project, create a folder named design (if it does not already exist) and create a design-system.json file in this folder that outlines the exact styling for all components and styles in this app along with the high-level design guidelines. The goal with the file is to create a comprehensive guide for AI to follow when building new features in this app. Use the implemented Tailwind classes and component structures from the showcase app as the source of truth.
```

**Result:** A comprehensive `design/design-system.json` containing:
- Exact Tailwind utility classes for every component.
- Specific rules for spacing, interaction, and motion.
- High-level design guidelines, do's and don'ts, and any constraints that should always be respected.

## Interaction Model

- **Human-in-the-loop review:** After Phase 3, the human reviews the running app and requests adjustments before codifying the final system.
- **Iterative refinement:** It is acceptable to rerun Phase 3 and Phase 4 if the visual direction changes or the reference design is updated.
- **Single source of truth:** Once stable, treat `design/design-system.json` as the canonical design reference and update it when the real design system evolves.

## How to Use the Result

- **In AI coding tools:** Always include `@design/design-system.json` (and optionally `@design/design.json`) when asking an AI assistant to build new features or screens so that outputs match the established style.
- **In UI design workflows:**
  - Use these files as inputs to higher-level UI prompt workflows (for tools like Figma Make or UX-specific agents).
  - Paste their contents into "knowledge" or "system prompt" areas when available.
- **As team documentation:** Treat the JSON files as living design docs that sit alongside your codebase, especially helpful for onboarding and for aligning multiple assistants on the same visual language.

## Target Audience

This rule is written for developers and AI assistants (such as Claude Code and similar tools) who want to extract a design system from a reference UI and then keep future AI-generated work visually consistent with that system.
