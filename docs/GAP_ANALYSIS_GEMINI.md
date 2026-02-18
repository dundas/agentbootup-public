# Gap Analysis: Gemini CLI Support

This document tracks the gaps between the current implementation of Gemini CLI support and a "Ready to Merge" production state.

## 1. Technical Hallucinations & Terminology (High Priority) [ADDRESSED]

| Gap | Description | Required Change | Status |
|-----|-------------|-----------------|--------|
| **Invalid Versions** | References to "Gemini CLI v2.0.60+". | Replace with "Gemini CLI 0.x". | Done (Parallel, Dialectical) |
| **Claude-Specific Tools** | References to `Task tool`. | Replace with `run_shell_command`. | Done (Parallel, Dialectical) |
| **Invalid Commands** | References to Claude-specific commands like `/tasks`. | Replace with Gemini CLI equivalents (e.g. `/skills list`, `/stats`) or shell job control. | Done (Parallel) |
| **Background Syntax** | References to `run_in_background: true`. | Replace with shell `&`. | Done (Parallel) |

## 2. Tool Invocation & Orchestration (High Priority) [ADDRESSED]

| Gap | Description | Required Change | Status |
|-----|-------------|-----------------|--------|
| **Subagent Syntax** | Examples use Claude's `Task()`. | Update to `gemini "..."` (positional prompt) or `gemini --prompt "..."` (deprecated). | Done (Parallel, Dialectical) |
| **Orchestration Logic** | Relies on Claude's multi-call. | Update to show bash parallelization. | Done (Parallel) |
| **Identity Crisis** | Subagents lack role clarity. | Add "You are the [Role]" to prompts. | Done (Parallel, Dialectical) |

## 3. Skill Discovery Optimization (Medium Priority)

| Gap | Description | Required Change |
|-----|-------------|-----------------|
| **Descriptions** | Metadata `description` fields are generic. | Add explicit "Use when..." and keyword-rich triggers for semantic matching. |
| **Precedence** | User may have conflicting global skills. | Document how to use `/skills disable` for local project overrides. |

## 4. Integration with Gemini-Native Agents (Medium Priority)

| Gap | Description | Required Change |
|-----|-------------|-----------------|
| **Codebase Investigator** | Workflows don't explicitly call the native sub-agent. | Update `tasklist-generator` and `task-processor` to recommend `codebase_investigator` for research. |
| **Skill Validation** | No automated check for `SKILL.md` YAML compliance. | Add a basic validation step to `bootup.mjs` or a standalone script. |

## 5. Documentation & UX (Low Priority)

| Gap | Description | Required Change |
|-----|-------------|-----------------|
| **Migration Guide** | No instructions for users to move from `.claude` to `.gemini`. | Add a "Migration" section to `GEMINI.md`. |
| **Visual Assets** | Placeholders for Gemini icons or screenshots. | Use standard markdown emoji or simple text icons. |

---

## Action Plan

1. **Scrub Claude-isms**: Update `task-processor-parallel`, `task-processor-auto`, and `tasklist-generator`.
2. **Update Orchestration Examples**: Swap `Task tool` for `run_shell_command`.
3. **Refine Discovery**: Update all `SKILL.md` frontmatter descriptions.
4. **Final Validation**: Run a full seeding test and verify skill discovery in a live Gemini CLI session.
