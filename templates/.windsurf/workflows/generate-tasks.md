# Generate Tasks
Create high-level parent tasks and gated sub-tasks from a PRD.

## Steps
1. Ask the user to select a PRD file under `/tasks/` (e.g., `/tasks/0001-prd-remote-mcp-server.md`).
2. Use @skills/tasklist-generator/SKILL.md to:
   - Generate ONLY parent (high‑level) tasks. Present them and PAUSE.
   - Wait for the user to reply "Go".
   - On "Go", generate detailed sub‑tasks, a "Relevant Files" section, and testing guidance.
3. Save the output to `/tasks/tasks-[prd-file-name].md`.
4. Summarize next actions and provide a link to the tasks file.
