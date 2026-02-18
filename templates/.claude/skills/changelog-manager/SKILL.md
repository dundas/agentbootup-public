---
name: changelog-manager
description: Create and update CHANGELOG.md with entries that include AI model/CLI attribution, PRD context, and task references.
category: quality
---

# Changelog Manager

## Goal
Maintain a comprehensive CHANGELOG.md that tracks all changes with attribution to the AI model/CLI that made them, linked to PRDs and tasks when applicable.

## Input
- **Entry type**: Manual entry, PR-based entry, or bulk update
- **Change description**: What was changed
- **Optional context**: PRD file path, task reference, PR number

## Output
- **File**: `CHANGELOG.md` at repository root
- **Format**: Enhanced Keep a Changelog with attribution metadata

---

## Process

### Phase 1: Initialization

1. **Detect AI Model/CLI**
   ```bash
   # Auto-detect which AI is running
   # Claude Code: Check for CLAUDE_CODE_VERSION env var or .claude directory
   # Gemini: Check for .gemini directory
   # Codex: Check for .codex directory
   # Default: "AI Assistant"

   if [[ -d ".claude" ]] || [[ -n "$CLAUDE_CODE_VERSION" ]]; then
     AI_SYSTEM="Claude Code"
   elif [[ -d ".gemini" ]]; then
     AI_SYSTEM="Gemini CLI"
   elif [[ -d ".codex" ]]; then
     AI_SYSTEM="Codex"
   else
     AI_SYSTEM="AI Assistant"
   fi
   ```

2. **Check if CHANGELOG.md exists**
   ```bash
   if [[ ! -f CHANGELOG.md ]]; then
     echo "CHANGELOG.md not found. Creating..."
     # Initialize new changelog (see template below)
   fi
   ```

### Phase 2: Entry Creation

3. **Gather Entry Details**

   Ask the user:
   ```
   What type of change is this?
   a) Added (new feature)
   b) Fixed (bug fix)
   c) Changed (refactor, improvement)
   d) Deprecated (feature marked for removal)
   e) Removed (feature removed)
   f) Security (security fix)
   g) Documentation (docs only)
   ```

4. **Gather Context**

   Ask the user:
   ```
   Related to a PRD? (optional)
   - If yes: path to PRD file (e.g., tasks/0001-prd-feature.md)

   Related to a task? (optional)
   - If yes: task reference (e.g., Task 1.2 from tasks-0001-prd-feature.md)

   Related to a PR? (optional)
   - If yes: PR number
   ```

5. **Capture Description**

   Prompt:
   ```
   Describe the change in one line:
   (e.g., "User profile editing with avatar upload")
   ```

6. **Generate Entry**

   Format:
   ```markdown
   - [Description] ([AI System], YYYY-MM-DD)
     - **Context:** [PRD link] | Task [reference] | PR #[number]
   ```

   If no context:
   ```markdown
   - [Description] ([AI System], YYYY-MM-DD)
   ```

### Phase 3: Update CHANGELOG.md

7. **Parse Existing Changelog**
   - Find `[Unreleased]` section
   - Find appropriate category subsection (### Added, ### Fixed, etc.)
   - Create subsection if it doesn't exist

8. **Insert Entry**
   ```bash
   # Insert under appropriate category in [Unreleased]
   # Maintain chronological order (newest first)
   ```

9. **Validate Format**
   - Ensure proper markdown structure
   - Verify all links are valid
   - Check for duplicate entries

10. **Commit Changes**
    ```bash
    # Verify CHANGELOG.md exists and was modified
    [[ -f CHANGELOG.md ]] || {
      echo "❌ Error: CHANGELOG.md not found"
      exit 1
    }

    # Check if file was actually modified
    git diff CHANGELOG.md | grep -q . || {
      echo "⚠️  Warning: CHANGELOG.md not modified. Entry may already exist."
      echo "Skipping commit."
      exit 0
    }

    # Stage the changelog
    git add CHANGELOG.md || {
      echo "❌ Error: Failed to stage CHANGELOG.md"
      exit 1
    }

    # Commit with error handling
    git commit -m "docs(changelog): add entry for [description]

    Added by $AI_SYSTEM

    " || {
      echo "❌ Error: git commit failed"
      echo "This may be due to:"
      echo "  - Pre-commit hooks failing"
      echo "  - No git user configured"
      echo "  - Repository in bad state"
      git status
      exit 1
    }

    # Verify commit succeeded
    git log -1 --oneline | grep -q "docs(changelog)" || {
      echo "❌ Error: Commit verification failed"
      exit 1
    }

    echo "✅ CHANGELOG.md updated and committed successfully"
    ```

---

## CHANGELOG.md Template

### Initial Creation
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
- **Attribution** - Which AI model/CLI made the change (Claude Code, Gemini CLI, etc.)
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

## Entry Formats

### With Full Context
```markdown
### Added
- Real-time notifications via WebSocket (Claude Code, 2025-01-16)
  - **Context:** [PRD](tasks/0003-prd-notifications.md) | Task 2.1 | PR #45
  - **Details:** Implemented server-sent events with fallback to polling
```

### With PRD Only
```markdown
### Fixed
- Login session timeout on mobile (Gemini CLI, 2025-01-15)
  - **Context:** [PRD](tasks/0001-prd-auth.md)
```

### With Task Only
```markdown
### Changed
- Refactored database connection pooling (Claude Code, 2025-01-14)
  - **Context:** Task 3.4 from [tasks-0005-prd-performance.md](tasks/tasks-0005-prd-performance.md)
```

### With PR Only (Auto-generated)
```markdown
### Security
- Patched XSS vulnerability in message rendering (Claude Code, 2025-01-13)
  - **Context:** PR #49
```

### Minimal Entry (No Context)
```markdown
### Documentation
- Updated API documentation (Codex, 2025-01-12)
```

---

## Bulk Update Mode

For updating changelog from multiple PRs or commits:

1. **Scan Git History**
   ```bash
   # Get commits since last changelog update
   git log --oneline --since="$(git log -1 --format=%ai CHANGELOG.md)" --no-merges
   ```

2. **Parse Each Commit**
   - Extract conventional commit type
   - Extract description
   - Check for PR reference in commit message

3. **Generate Entries**
   - Group by category (Added/Fixed/Changed/etc.)
   - Add attribution based on co-author tag or default to current AI

4. **Present for Review**
   - Show proposed entries
   - Allow user to edit before inserting

---

## Version Release

When releasing a new version:

1. **Move [Unreleased] to Version Section**
   ```markdown
   ## [1.2.0] - 2025-01-16

   ### Added
   [All entries from Unreleased/Added]

   ### Fixed
   [All entries from Unreleased/Fixed]

   ...

   ## [1.1.0] - 2025-01-10
   ...
   ```

2. **Reset [Unreleased]**
   ```markdown
   ## [Unreleased]

   ### Added

   ### Fixed

   ### Changed

   ### Deprecated

   ### Removed

   ### Security
   ```

3. **Commit**
   ```bash
   git add CHANGELOG.md
   git commit -m "docs(changelog): release v1.2.0"
   git tag v1.2.0
   ```

---

## Integration with PR Review Loop

The `pr-review-loop` skill automatically calls this skill after merging:

```bash
# After PR merge:
changelog-manager \
  --type "Added" \
  --description "Feature from PR title" \
  --pr 123 \
  --auto
```

This adds an entry without user prompting.

---

## Interaction Model

### Manual Mode (Default)
- Prompts user for change type, description, context
- Interactive and guided

### Auto Mode (from PR merge)
- Accepts parameters via flags
- No user interaction
- Used by pr-review-loop

### Bulk Mode
- Scans git history
- Proposes entries for review
- User confirms/edits before insertion

---

## Key Principles

1. **Attribution** - Every entry shows which AI made the change
2. **Context** - Link to PRD/task/PR when available
3. **Chronological** - Newest entries first within each category
4. **Searchable** - Easy to find when a change was made and by whom
5. **Standard Format** - Keep a Changelog compliance

---

## References
- See `reference.md` for format examples
- Keep a Changelog: https://keepachangelog.com/en/1.0.0/
