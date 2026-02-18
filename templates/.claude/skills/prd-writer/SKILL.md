---
name: prd-writer
description: Create a clear, actionable PRD with clarifying questions and a junior-friendly structure.
category: workflow
---

# PRD Writer

## Goal
Create a detailed Product Requirements Document (PRD) in Markdown from an initial feature prompt, suitable for a junior developer.

## Process
1. Receive initial prompt from user.
2. Ask clarifying questions before writing. Provide options in letter/number lists for easy replies.
3. Generate the PRD using the structure below.
4. Save as `[n]-prd-[feature-name].md` under `/tasks/` where `n` is zero‑padded (e.g., `0001-prd-user-authentication.md`).

### Clarifying questions (guide)
- Problem/Goal: What problem does this solve? What is the main goal?
- Target User: Who is the primary user?
- Core Functionality: Key actions the user must perform?
- User Stories: Provide a few stories (As a…, I want…, so that…)
- Acceptance Criteria: How do we know it’s done/successful?
- Scope/Boundaries: Any explicit non-goals?
- Data Requirements: What data to display/manipulate?
- Design/UI: Any mockups/guidelines? Desired look/feel?
- Edge Cases: Potential edge cases and error conditions?

## PRD Structure
1. Introduction/Overview
2. Goals
3. User Stories
4. Functional Requirements (numbered)
5. Non-Goals (Out of Scope)
6. Design Considerations (Optional)
7. Technical Considerations (Optional)
8. Success Metrics
9. Open Questions

## Output
- Format: Markdown (.md)
- Location: `/tasks/`
- Filename pattern: `[n]-prd-[feature-name].md`

## Interaction
- Always ask clarifying questions before writing.
- Incorporate the answers and refine the PRD accordingly.

## Key Principles
- **No Arbitrary Timeframes**: Never include time estimates, schedules, or delivery dates (e.g., "this will take 2-3 weeks", "Phase 1 in Q1"). Focus on what needs to be done, not when. Let users decide scheduling.
- **Actionable Requirements**: Provide concrete implementation steps and dependencies instead of timelines.
- **Complexity Over Duration**: If needed, indicate relative complexity (trivial/small/medium/large) rather than time estimates.

## References
- See `reference.md`.
