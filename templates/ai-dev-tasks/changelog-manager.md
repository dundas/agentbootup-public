<!-- AUTO-GENERATED from .claude/skills/changelog-manager/SKILL.md -->
# Rule: Changelog Manager

## Goal

Maintain a comprehensive CHANGELOG.md that tracks all changes with attribution to the AI model/CLI that made them, linked to PRDs and tasks when applicable.

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

---

*This is an auto-generated reference. For full documentation with examples, see `.claude/skills/changelog-manager/SKILL.md` and `reference.md`.*
