# Rule: Managing the Changelog

## Goal

To guide an AI assistant in creating and updating CHANGELOG.md with entries that include AI model/CLI attribution, PRD context, and task references.

## Output

- **File:** `CHANGELOG.md` at repository root
- **Format:** Enhanced Keep a Changelog with attribution metadata

## Process

### Phase 1: Initialization

1. **Detect AI System**
   Automatically identify which AI model/CLI is running:
   - Claude Code: Check for `.claude/` directory or `CLAUDE_CODE_VERSION` env var
   - Gemini CLI: Check for `.gemini/` directory
   - Codex: Check for `.codex/` directory
   - Default: "AI Assistant"

2. **Check for CHANGELOG.md**
   If it doesn't exist, create it with the standard template (see below).

### Phase 2: Entry Creation

3. **Determine Change Type**
   Ask the user to select:
   - **Added** - New feature
   - **Fixed** - Bug fix
   - **Changed** - Refactor or improvement
   - **Deprecated** - Feature marked for removal
   - **Removed** - Feature removed
   - **Security** - Security fix
   - **Documentation** - Docs only

4. **Gather Context (Optional)**
   Ask the user:
   - **PRD:** Path to related PRD file (e.g., `tasks/0001-prd-auth.md`)
   - **Task:** Task reference (e.g., "Task 1.2" or "Task 1.2 from tasks-0001-prd-auth.md")
   - **PR:** Pull request number

5. **Get Description**
   Prompt for a one-line description:
   > "Describe the change in one line (e.g., 'User profile editing with avatar upload'):"

### Phase 3: Format Entry

6. **Generate Entry**

   **With full context:**
   ```markdown
   - [Description] ([AI System], YYYY-MM-DD)
     - **Context:** [PRD](tasks/file.md) | Task X.Y | PR #N
   ```

   **With partial context:**
   ```markdown
   - [Description] ([AI System], YYYY-MM-DD)
     - **Context:** [PRD](tasks/file.md)
   ```

   **Minimal (no context):**
   ```markdown
   - [Description] ([AI System], YYYY-MM-DD)
   ```

### Phase 4: Update CHANGELOG.md

7. **Parse Existing Changelog**
   - Locate `[Unreleased]` section
   - Find or create the appropriate category subsection (### Added, ### Fixed, etc.)

8. **Insert Entry**
   - Add the new entry under the correct category
   - Maintain chronological order (newest first within each category)

9. **Validate**
   - Ensure proper markdown formatting
   - Verify links are valid
   - Check for duplicate entries

10. **Commit**
    ```bash
    git add CHANGELOG.md
    git commit -m "docs(changelog): add entry for [description]

    Added by [AI System]

    "
    ```

---

## CHANGELOG.md Template

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
with enhanced attribution to track which AI model/CLI made each change.

## [Unreleased]

### Added

### Fixed

### Changed

### Deprecated

### Removed

### Security

---

## Format Notes

Each entry includes:
- **Description** - What was changed
- **Attribution** - Which AI model/CLI made the change
- **Date** - When the change was made (YYYY-MM-DD)
- **Context** (optional) - Links to PRD, task reference, or PR number

Example:
```
### Added
- User profile editing with avatar upload (Claude Code, 2025-01-16)
  - **Context:** [PRD](tasks/0001-prd-user-profile.md) | Task 1.2 | PR #42
```

---

*Changelog initialized YYYY-MM-DD*
```

---

## Interaction Model

### Manual Mode
- Prompt user for change type
- Ask for description
- Optionally ask for context (PRD/task/PR)
- Insert entry and commit

### Auto Mode (from PR merge)
- Accept parameters programmatically
- No user prompts
- Automatically insert and commit

---

## Entry Examples

### With Full Context
```markdown
### Added
- Real-time notifications via WebSocket (Claude Code, 2025-01-16)
  - **Context:** [PRD](tasks/0003-prd-notifications.md) | Task 2.1 | PR #45
```

### With PRD + Task
```markdown
### Fixed
- Memory leak in WebSocket connections (Gemini CLI, 2025-01-15)
  - **Context:** [PRD](tasks/0002-prd-realtime.md) | Task 2.4
```

### With PR Only
```markdown
### Changed
- Refactored database migrations (Claude Code, 2025-01-14)
  - **Context:** PR #45
```

### Minimal
```markdown
### Documentation
- Updated API documentation (Codex, 2025-01-13)
```

---

## Key Principles

1. **Auto-detect AI system** - Don't ask the user which AI they're using
2. **Attribution is mandatory** - Every entry must show ([AI System], YYYY-MM-DD)
3. **Context is optional** - But encouraged for traceability
4. **Chronological order** - Newest entries first within each category
5. **Keep a Changelog compliance** - Standard format for compatibility

---

## Integration with PR Review

After a PR is merged, the `pr-review-loop` skill automatically calls `changelog-manager` with:
- Type: Detected from conventional commit prefix
- Description: Extracted from PR title
- PR: PR number
- Auto mode: No user prompts

---

## Target Audience

This rule guides AI assistants to:
- Maintain a comprehensive changelog
- Track which AI made which changes
- Link changes to PRDs and tasks for full traceability
- Support both manual and automated changelog updates
