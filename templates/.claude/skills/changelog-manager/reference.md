# Changelog Manager Reference

## Source
- Skill: `changelog-manager/SKILL.md`
- Standard: [Keep a Changelog 1.0.0](https://keepachangelog.com/en/1.0.0/)

## AI System Detection

### Auto-Detection Logic
```bash
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

### Attribution Format
```
([AI System], YYYY-MM-DD)
```

Examples:
- `(Claude Code, 2025-01-16)`
- `(Gemini CLI, 2025-01-15)`
- `(Codex, 2025-01-14)`
- `(AI Assistant, 2025-01-13)`

---

## Entry Templates

### Full Context Entry
```markdown
### Added
- User authentication with OAuth2 support (Claude Code, 2025-01-16)
  - **Context:** [PRD](tasks/0001-prd-auth.md) | Task 1.3 | PR #42
  - **Details:** Implemented Google and GitHub OAuth providers with PKCE flow
```

### PRD + Task Entry
```markdown
### Fixed
- Memory leak in WebSocket connections (Gemini CLI, 2025-01-15)
  - **Context:** [PRD](tasks/0002-prd-realtime.md) | Task 2.4
```

### PR Only Entry (Auto-generated)
```markdown
### Changed
- Refactored database migrations to use Drizzle ORM (Claude Code, 2025-01-14)
  - **Context:** PR #45
```

### Minimal Entry
```markdown
### Documentation
- Added API endpoint documentation (Codex, 2025-01-13)
```

### With Additional Details
```markdown
### Security
- Fixed SQL injection vulnerability in search (Claude Code, 2025-01-12)
  - **Context:** Task 5.1 from [tasks-0010-prd-security-audit.md](tasks/tasks-0010-prd-security-audit.md)
  - **Details:** Parameterized all queries, added input sanitization
  - **Impact:** All versions since v1.0.0 affected
```

---

## Category Mapping

| Category | Use When | Examples |
|----------|----------|----------|
| **Added** | New features, endpoints, functionality | "User profile editing", "WebSocket support" |
| **Fixed** | Bug fixes, error corrections | "Login timeout", "Race condition in cache" |
| **Changed** | Refactors, improvements, updates | "Improved query performance", "Updated React to v18" |
| **Deprecated** | Features marked for future removal | "Legacy /api/v1 endpoints" |
| **Removed** | Features/code removed | "Dropped Node 14 support" |
| **Security** | Security patches, vulnerability fixes | "Patched XSS in comments" |
| **Documentation** | Docs-only changes (optional to include) | "Updated README" |

---

## Context Link Formats

### PRD Link
```markdown
[PRD](tasks/0001-prd-feature-name.md)
```

### Task Reference
```markdown
Task 1.2

# Or with file link:
Task 1.2 from [tasks-0001-prd-feature.md](tasks/tasks-0001-prd-feature.md)
```

### PR Reference
```markdown
PR #42

# Or with link (if public repo):
[PR #42](https://github.com/org/repo/pull/42)
```

### Combined Context
```markdown
[PRD](tasks/0001-prd-auth.md) | Task 1.3 | PR #42
```

---

## Complete Example Changelog

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
with enhanced attribution to track which AI model/CLI made each change.

## [Unreleased]

### Added
- User profile editing with avatar upload (Claude Code, 2025-01-16)
  - **Context:** [PRD](tasks/0001-prd-user-profile.md) | Task 1.2 | PR #42
  - **Details:** Supports PNG/JPG, max 5MB, auto-resize to 200x200
- Real-time notifications via WebSocket (Claude Code, 2025-01-16)
  - **Context:** [PRD](tasks/0003-prd-notifications.md) | Task 2.1 | PR #45
  - **Details:** Server-sent events with polling fallback
- Export data to CSV (Gemini CLI, 2025-01-15)
  - **Context:** Task 3.4 from [tasks-0005-prd-export.md](tasks/tasks-0005-prd-export.md)

### Fixed
- Login session timeout on mobile browsers (Claude Code, 2025-01-15)
  - **Context:** [PRD](tasks/0001-prd-auth.md) | PR #44
- Race condition in message delivery (Codex, 2025-01-14)
  - **Context:** Task 4.2
  - **Details:** Added optimistic locking with version numbers

### Changed
- Refactored authentication to use JWT tokens (Claude Code, 2025-01-14)
  - **Context:** [PRD](tasks/0001-prd-auth.md) | Task 1.5 | PR #46
  - **Details:** Migrated from sessions, reduced server memory by 60%
- Improved database query performance (Gemini CLI, 2025-01-14)
  - **Context:** PR #47
  - **Details:** Added indexes, query plan optimization, 70% faster

### Deprecated
- Legacy REST API v1 endpoints (Claude Code, 2025-01-13)
  - **Context:** [PRD](tasks/0008-prd-api-v2.md)
  - **Details:** Will be removed in v2.0.0, use /api/v2 instead

### Security
- Patched XSS vulnerability in message rendering (Claude Code, 2025-01-13)
  - **Context:** PR #49
  - **Details:** Sanitize HTML input, escape user content
  - **Impact:** Versions 1.0.0-1.1.2 affected

---

## [1.1.0] - 2025-01-10

### Added
- Dark mode support (Claude Code, 2025-01-09)
  - **Context:** [PRD](tasks/0002-prd-theming.md) | PR #38
- Email notifications (Gemini CLI, 2025-01-08)
  - **Context:** Task 2.3 | PR #36

### Fixed
- Memory leak in file upload (Claude Code, 2025-01-07)
  - **Context:** PR #35

---

## [1.0.0] - 2025-01-05

### Added
- Initial release (Claude Code, 2025-01-05)
  - **Context:** [PRD](tasks/0000-prd-mvp.md)
  - User authentication
  - Message board functionality
  - File uploads

---

*Changelog initialized 2025-01-05*
```

---

## Bulk Update Example

### Input (from git log)
```
feat(auth): add OAuth2 support
fix(api): handle rate limit errors
refactor(db): migrate to Prisma
docs: update README
```

### Generated Entries
```markdown
### Added
- OAuth2 support (Claude Code, 2025-01-16)
  - **Context:** Auto-generated from git history

### Fixed
- Rate limit error handling in API (Claude Code, 2025-01-16)
  - **Context:** Auto-generated from git history

### Changed
- Migrated to Prisma ORM (Claude Code, 2025-01-16)
  - **Context:** Auto-generated from git history

### Documentation
- Updated README (Claude Code, 2025-01-16)
```

---

## Version Release Example

### Before Release
```markdown
## [Unreleased]

### Added
- Feature A
- Feature B

### Fixed
- Bug X
```

### After Release (v1.2.0)
```markdown
## [Unreleased]

### Added

### Fixed

### Changed

### Deprecated

### Removed

### Security

---

## [1.2.0] - 2025-01-16

### Added
- Feature A (Claude Code, 2025-01-15)
- Feature B (Gemini CLI, 2025-01-14)

### Fixed
- Bug X (Claude Code, 2025-01-13)

---

## [1.1.0] - 2025-01-10
...
```

---

## Commit Messages

### Manual Entry
```bash
git commit -m "docs(changelog): add entry for user profile editing

Added by Claude Code

"
```

### Auto Entry (from PR)
```bash
git commit -m "docs(changelog): update for PR #42

Added by Claude Code
Context: PRD tasks/0001-prd-user-profile.md | Task 1.2

"
```

### Version Release
```bash
git commit -m "docs(changelog): release v1.2.0"
git tag v1.2.0
```

---

## Integration with Other Skills

### Called by pr-review-loop (Auto)
```bash
# After PR merge
changelog-manager --auto \
  --type "Added" \
  --description "User authentication with OAuth2" \
  --pr 42
```

### Called by task-processor-auto (Auto)
```bash
# After parent task complete
changelog-manager --auto \
  --type "Added" \
  --description "Real-time notifications" \
  --prd "tasks/0003-prd-notifications.md" \
  --task "2.1"
```

### Manual Invocation
```bash
# User runs command
/changelog-manager
```

---

## Search and Query Patterns

### Find all changes by AI system
```bash
grep "Claude Code" CHANGELOG.md
grep "Gemini CLI" CHANGELOG.md
```

### Find changes related to a PRD
```bash
grep "tasks/0001-prd-auth.md" CHANGELOG.md
```

### Find changes from a specific month
```bash
grep "2025-01" CHANGELOG.md
```

### Find all security patches
```bash
sed -n '/### Security/,/###/p' CHANGELOG.md
```
