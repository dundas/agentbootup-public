# agentbootup Runbook (Local + Production)

This runbook answers: "what needs to be running" for agentbootup to be tested and deployed effectively.

## System Pieces (What Talks To What)

**Runs on the developer machine**
- **agentbootup CLI** (`bootup.mjs`) - Copies template files from `templates/` to target project directories
- **Template sync script** (`scripts/sync-templates.mjs`) - Syncs templates from `.claude/` to `.gemini/` and `.codex/` platforms

**External dependencies**
- **Node.js** (>= 18) - Runtime for the CLI
- **Git** - Version control and GitHub integration
- **npm registry** - Production distribution platform

**No runtime services** - agentbootup is a pure CLI tool with no backend, database, or persistent services.

---

## Local Testing (What Must Be Running)

### Minimum to test "CLI installs templates"
1. **Node.js >= 18** installed
2. **Repository cloned** locally

That's it! agentbootup has no external dependencies for basic usage.

Docs:
- Main README: `README.md:1`
- Detailed usage guide: `BOOTUP.md:1`

### Full local development (testing all workflows)
In addition to the minimum:
3. **Git configured** (for commits and PR workflows)
4. **npm authentication** (for publishing workflow)
5. **GitHub CLI (`gh`)** installed (for PR testing)
6. **semgrep** installed (for pre-push security scanning):
   ```bash
   pipx install semgrep        # preferred — always adds to PATH
   # macOS fallback:
   brew install semgrep
   ```
7. **roborev** installed (for AI-powered pre-push review):
   ```bash
   brew install roborev-dev/tap/roborev
   ```
   > **Note**: Do NOT run `roborev init` — per-project setup is handled automatically by the `/pre-push-review` skill on first invocation.
   >
   > **Default agent + model (recommended once, global):** Cursor agent with `gpt-5.4-medium` for default and review:
   > ```bash
   > roborev config set --global default_agent cursor
   > roborev config set --global review_agent cursor
   > roborev config set --global default_model gpt-5.4-medium
   > roborev config set --global review_model gpt-5.4-medium
   > ```

Environment variables (optional, for PR workflow testing):
- `GITHUB_TOKEN` - For GitHub API access via `gh` CLI
- `NPM_TOKEN` - For npm publishing (stored in `~/.npmrc`)

---

### Local bring-up checklist

**1) Clone repository**
```bash
git clone https://github.com/dundas/agentbootup.git
cd agentbootup
```

**2) Install dependencies**
```bash
# agentbootup has no runtime dependencies!
# But check Node.js version:
node --version  # Should be >= 18
```

**3) Test basic CLI functionality**
```bash
# Dry-run to see what would be installed
node bootup.mjs seed --dry-run --verbose

# Install to current directory (test mode)
node bootup.mjs seed --target . --force

# Test specific subsets
node bootup.mjs seed --target /tmp/test-project --subset agents,skills
```

**4) Test template sync**
```bash
# Run template sync
npm run sync-templates

# Verify templates are in sync
npm run check-templates  # Should output: "Templates are in sync."
```

**5) Test via npm (global install simulation)**
```bash
# Link local version globally
npm link

# Test as if installed globally
agentbootup seed --dry-run --verbose

# Unlink when done
npm unlink -g agentbootup
```

**6) Smoke checks**
- CLI runs: `node bootup.mjs --help` (should not error)
- Dry-run works: `npm run dry-run` (should list files without copying)
- Template sync works: `npm run check-templates` (should pass)
- Test passes: `npm test` (currently just prints "ok")
- Phase 3 brain env mount (`mount`, `list-mounts`, `install --env-config`): `bun run smoke:brain-mount` — exercises the real `bootup.mjs` entrypoint with temp dirs and `AGENTBOOTUP_MOUNTS_BASE` (does not write `~/.brain/mounts`)
- Branch overlay runtime: `npm run smoke:branch-overlay` — exercises the real `bootup.mjs brain doctor --branch-mode` path against a temp RO/RW overlay plus local registry stub, then verifies allowed vs disallowed runtime writes

**7) Network environments (optional — portfolio `agentbootup.json`)**

If you maintain a network root with `agentbootup.json` (`role: "network"`), you can add **`environments/<name>.json`** manifests (see `BOOTUP.md` — Network mode) and run:

- `agentbootup install --env <name> --dry-run` then `agentbootup install --env <name>`
- `agentbootup provision --env <name>` to provision all listed projects in order

Validation failures (unknown `project.id`, duplicate ids, `id` not matching the filename) exit non-zero before any provision runs.

---

## PRD-0072 Task 1.3 runtime qualification

Current disposition: **GO** for the bounded Task 1.3 prerequisite at Mech Plane
`ab4c156313d6d5b43c00edf5458e2e3a38ab3e6c`, direct parent
`3822a1bc9a27ac402414de708c8f9f8d781979df`. The retained atomic receipt is
[`tasks/evidence/0072/mech-plane-runtime-approval-linux-arm64-ab4c156-2026-08-20.json`](tasks/evidence/0072/mech-plane-runtime-approval-linux-arm64-ab4c156-2026-08-20.json).
Historical dated NO_GO receipts remain authoritative for their earlier targets.

Requalification is required if the Mech Plane target/parent, qualifier source,
`@mech/run`, Codex launcher/native package, platform, or evidence schema changes.
Run only from a clean detached Mech Plane checkout on Linux/ARM64. Supply a new
output filename, an existing durable effect directory outside the checkout and
system temporary roots, integrity-matching Codex tarballs, and an isolated
credential home. Never retain credential contents or runtime/provider text.

```bash
export CODEX_HOME="$ISOLATED_CODEX_HOME"
bun tasks/evidence/0072/qualify-mech-plane-runtime-successor.ts \
  --mech-plane "$CLEAN_MECH_PLANE_CHECKOUT" \
  --output "$NEW_RECEIPT_UNDER_TASKS_EVIDENCE_0072" \
  --allow-real-agent \
  --outside-base "$DURABLE_EFFECT_BASE" \
  --codex-launcher-tarball "$CODEX_0_148_LAUNCHER_TARBALL" \
  --codex-package-tarball "$CODEX_0_148_LINUX_ARM64_TARBALL" \
  --credential-profile auth_plus_config \
  --codex-auth-file "$ISOLATED_CODEX_HOME/auth.json" \
  --codex-config-file "$ISOLATED_CODEX_HOME/config.toml" \
  --soak-timeout-ms=600000
```

The qualifier fails closed unless source commit and direct parent match, the
checkout is clean before and after, all package integrities and executed Mech
Run bytes match, the platform/runtime matches, and the complete two-cycle matrix
has per-row `nativeToolObserved`, binding digest, expiry, decision/effect, and
attempt evidence with zero retries and zero case failures. It atomically writes
the sanitized receipt with its own source SHA-256 in the same invocation. A
post-run sidecar cannot substitute for that binding. This GO does not implement
or qualify a connector, route, relay, mapper, rollout, or package publication.

---

## Production Testing (What Must Be Running)

### Minimum production deployment
- **Package published** to npm registry at `https://registry.npmjs.org/agentbootup`
- **Git tags** for version tracking
- **GitHub releases** (optional but recommended)

Production "secrets":
- **npm auth token** (stored in `~/.npmrc` or `NPM_TOKEN` env var)
- **Git credentials** for pushing tags

Docs:
- Publishing workflow: See `scripts` section in `package.json`
- Changelog: `CHANGELOG.md`

---

### Production deployment checklist

**1) Pre-publish checks**
```bash
# Ensure working directory is clean
git status

# Ensure templates are in sync
npm run check-templates

# Verify package.json version is updated
cat package.json | grep version
```

**2) Update version**

Choose one of two approaches:

**Approach A: Using npm version (recommended)**
```bash
# npm version automatically commits and tags
npm version patch   # 0.4.0 -> 0.4.1
npm version minor   # 0.4.0 -> 0.5.0
npm version major   # 0.4.0 -> 1.0.0

# Push commit and tag
git push origin main --follow-tags
```

**Approach B: Manual version bump**
```bash
# 1. Manually edit package.json version field
# 2. Commit and tag
git add package.json
git commit -m "0.5.0"
git tag 0.5.0

# 3. Push commit and tag
git push origin main
git push origin 0.5.0
```

**3) Authenticate with npm**
```bash
# Option A: Interactive login (recommended)
npm login

# Option B: Token-based auth (for CI/CD)
npm config set //registry.npmjs.org/:_authToken YOUR_TOKEN

# SECURITY WARNING:
# - Never commit ~/.npmrc to git (contains sensitive tokens)
# - For local dev: Use 'npm login' (interactive)
# - For CI/CD: Use environment variables (NPM_TOKEN) instead of file-based auth
# - Don't use shell redirection (> or >>) to write tokens - use npm config set
```

**4) Publish to npm**
```bash
npm publish

# Verify publication
npm view agentbootup version  # Should show new version
```

**5) Verify installation**
```bash
# Test global install
npx agentbootup@latest seed --dry-run

# Or install globally
npm i -g agentbootup
agentbootup --version
```

---

### Production smoke test checklist

1. **Package is published**: `npm view agentbootup version` returns correct version
2. **Installation works**: `npx agentbootup --help` runs without error
3. **Templates install**: `npx agentbootup seed --target /tmp/test --subset agents` copies files successfully
4. **All subsets work**: Test `--subset agents,skills,commands,workflows,docs`
5. **GitHub release created** (optional): Check https://github.com/dundas/agentbootup/releases
6. **Changelog updated**: `CHANGELOG.md` has entry for the new version

Verification commands:
```bash
# Check npm registry
npm view agentbootup

# Test npx installation
npx agentbootup@latest seed --dry-run --verbose

# Test global installation
npm i -g agentbootup
agentbootup seed --target /tmp/smoke-test --dry-run
```

---

## Development Workflow

### Making changes to templates

1. **Edit templates in `.claude/` directory**
   - Agents: `templates/.claude/agents/`
   - Skills: `templates/.claude/skills/`
   - Commands: `templates/.claude/commands/`

2. **Sync to other platforms**
   ```bash
   npm run sync-templates
   ```

3. **Verify sync worked**
   ```bash
   npm run check-templates
   ```

4. **Test changes locally**
   ```bash
   node bootup.mjs seed --target /tmp/test-project --force
   ```

---

## Internal/Public Promotion Runbook

Transcript archive backup, deep verification, clean-machine restore, fail-closed offload planning, production durability evidence, and incident response are documented in [`docs/TRANSCRIPT_ARCHIVE_RUNBOOK.md`](docs/TRANSCRIPT_ARCHIVE_RUNBOOK.md). Local deletion remains disabled while its production evidence verdict is `PAUSE`.

Use this project as the **internal source of truth**, then promote approved files to the public repo.

Authoritative strategy doc:
- `docs/INTERNAL_PUBLIC_STRATEGY.md`

### Required checks (internal repo)

```bash
npm run check-templates
npm run public:check
```

### Export-only flow

```bash
node scripts/public-sync.mjs export --target ../agentbootup-public --clean
```

This writes:
- `../agentbootup-public/.public-export-manifest.txt`
- `../agentbootup-public/.public-excluded.txt`

### Automated promotion flow

```bash
node scripts/public-promote.mjs --public-repo ../agentbootup-public
```

What it does:
1. Exports policy-approved files.
2. Checks out a promotion branch in the public repo.
3. Replaces contents with export snapshot (keeps `.git`).
4. Commits and pushes.
5. Creates a PR via `gh` (unless `--no-pr` is set).

### `pr-review-loop` usage

- Internal PRs: run architecture/quality checks and `public:check` gate.
- Public PRs: run OSS quality review and compatibility checks only.
- Promotion PRs: must come from export output; do not hand-edit private assets into public repo.

### Creating a new skill

1. **Create skill directory under `.claude/skills/`**
   ```bash
   mkdir -p templates/.claude/skills/my-new-skill
   ```

2. **Create SKILL.md and reference.md**
   ```bash
   touch templates/.claude/skills/my-new-skill/SKILL.md
   touch templates/.claude/skills/my-new-skill/reference.md
   ```

3. **Add to CODEX_SKILLS_ALLOWLIST** (if needed)
   - Edit `scripts/sync-templates.mjs`
   - Add skill name to `CODEX_SKILLS_ALLOWLIST` Set
   - Note: Codex supports skills but not Claude-style subagents. Only add validated skills that work in Codex.

4. **Sync templates**
   ```bash
   npm run sync-templates
   ```

5. **Test locally**
   ```bash
   node bootup.mjs seed --target /tmp/test --subset skills
   ```

### PR workflow

1. **Create feature branch**
   ```bash
   git checkout -b feat/my-feature
   ```

2. **Make changes and commit**
   ```bash
   git add -A
   git commit -m "feat: add my feature"
   git push -u origin feat/my-feature
   ```

3. **Create PR**
   ```bash
   gh pr create --title "Add my feature" --body "Description..."
   ```

4. **After review, merge**
   ```bash
   gh pr merge <number> --squash --delete-branch
   ```

5. **Update CHANGELOG.md**
   - Add entry under `[Unreleased]` section
   - Use format: `- Description (AI System, YYYY-MM-DD)`

---

## Notes / Common Gotchas

- **Node version mismatch**: agentbootup requires Node.js >= 18. Check with `node --version`.
- **Template sync out of date**: Always run `npm run check-templates` before committing. If out of sync, run `npm run sync-templates`.
- **Overwriting existing files**: By default, agentbootup skips existing files. Use `--force` to overwrite.
- **Subset filtering**: Valid subsets are: `agents`, `skills`, `commands`, `workflows`, `docs`. Use comma-separated list: `--subset agents,skills`.
- **npm publish errors**: If you see "E404 Not found", you likely need to authenticate with `npm login`.
- **Access token expired**: npm tokens expire. Generate a new one at https://www.npmjs.com/settings/tokens and update `~/.npmrc`.
- **Path normalization**: agentbootup works cross-platform (Windows and Unix). Both forward slashes (`/`) and backslashes (`\`) work in `--target` paths - they're normalized automatically by Node.js path handling.
- **Testing changes locally**: Use `node bootup.mjs` directly instead of `npx agentbootup` to test uncommitted changes.
- **Forgetting to push tags**: After `git tag`, remember to `git push origin <tag-name>` so GitHub shows the release.
- **CODEX_SKILLS_ALLOWLIST**: Not all Claude skills work in Codex. Only add validated skills to the allowlist in `sync-templates.mjs`.

---

## Quick Reference

### Common commands

```bash
# Development
node bootup.mjs seed --dry-run --verbose     # Preview what would be installed
npm run sync-templates                  # Sync .claude/ to .gemini/ and .codex/
npm run check-templates                 # Verify templates are in sync
npm test                                # Run tests (currently minimal)

# Testing CLI
node bootup.mjs seed --target /tmp/test      # Install to test directory
node bootup.mjs seed --target . --force      # Install to current dir (overwrite)
npm link                                # Link locally for global testing

# Publishing
npm version patch                       # Bump patch version (0.4.0 -> 0.4.1)
npm publish                             # Publish to npm registry
npm view agentbootup                    # Check published package info

# GitHub workflow
gh pr create                            # Create pull request
gh pr checks                            # View CI status
gh pr merge <number> --squash           # Merge and delete branch
```

### File structure

```
agentbootup/
├── bootup.mjs                 # Main CLI executable
├── package.json               # npm package definition
├── README.md                  # User-facing documentation
├── BOOTUP.md                  # Detailed CLI usage guide
├── CHANGELOG.md               # Version history
├── RUNBOOK.md                 # This file
├── scripts/
│   └── sync-templates.mjs     # Template sync script
└── templates/                 # Template files to be copied
    ├── .claude/               # Claude Code assets (canonical source)
    │   ├── agents/            # Claude subagents
    │   ├── skills/            # Multi-file skills
    │   └── commands/          # Slash commands
    ├── .gemini/               # Gemini CLI assets (synced)
    ├── .codex/                # OpenAI Codex assets (synced, subset)
    ├── .windsurf/workflows/   # Windsurf Cascade workflows
    └── ai-dev-tasks/          # Documentation for AI assistants
```

### Helpful links

- GitHub repo: https://github.com/dundas/agentbootup
- npm package: https://www.npmjs.com/package/agentbootup
- Issues: https://github.com/dundas/agentbootup/issues
- Pull requests: https://github.com/dundas/agentbootup/pulls

---

*Runbook generated 2026-01-16 by runbook-generator skill*
