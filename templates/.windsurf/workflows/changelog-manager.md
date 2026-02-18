# Changelog Manager
Create or update CHANGELOG.md with AI attribution and context.

## Steps

1. **Detect AI System**
   - Auto-detect: Claude Code | Gemini CLI | Codex | AI Assistant
   - Check for `.claude/`, `.gemini/`, `.codex/` directories

2. **Check for CHANGELOG.md**
   - If missing: create using @skills/changelog-manager/SKILL.md template
   - If exists: parse to find [Unreleased] section

3. **Gather Entry Details**
   - Ask: "What type of change?" (Added/Fixed/Changed/Deprecated/Removed/Security/Documentation)
   - Prompt: "Describe the change in one line"
   - Ask (optional): "Related PRD file path?"
   - Ask (optional): "Related task reference?"
   - Ask (optional): "Related PR number?"

4. **Format Entry**
   - With full context:
     ```
     - [Description] ([AI System], YYYY-MM-DD)
       - **Context:** [PRD](path) | Task X.Y | PR #N
     ```
   - Or minimal:
     ```
     - [Description] ([AI System], YYYY-MM-DD)
     ```

5. **Update CHANGELOG.md**
   - Insert under appropriate category in [Unreleased]
   - Maintain chronological order (newest first)
   - Validate markdown formatting

6. **Commit**
   ```bash
   git add CHANGELOG.md
   git commit -m "docs(changelog): add entry for [description]

   Added by [AI System]"
   ```

7. **Confirm**
   - Show inserted entry
   - Log: "CHANGELOG.md updated successfully"

## Auto Mode (for PR merge)
- Skip prompts, accept parameters directly
- Used by /pr-review-loop workflow
