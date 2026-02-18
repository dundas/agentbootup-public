# Internal vs Public Strategy

## Goal

Run two versions safely:

- **Internal (private):** full operational system (`brain/`, inbox workflows, private skills, internal automation).
- **Public (open source):** reusable core CLI, templates, and documentation with no internal operations data.

## Repository Model

1. `agentbootup-internal` (private, source of truth)
2. `agentbootup` (public OSS mirror of approved files only)

Keep flow one-way for releases:

- Internal -> Public via promotion PRs.
- Never make direct public-only changes that bypass internal review.

## Promotion Controls

Policy file:

- `config/public-release-policy.json`

Tooling:

- `node scripts/public-sync.mjs check`
- `node scripts/public-sync.mjs export --target <public-repo-path> --clean`
- `node scripts/public-promote.mjs --public-repo <public-repo-path>`

The policy controls:

- `include_roots` and `include_files`: what is eligible for public release.
- `exclude_roots` and `exclude_globs`: what must never be exported.
- `required_files`: minimum OSS release contract.

## CI Guardrails

Workflows:

- `.github/workflows/public-sync-check.yml`: runs `public:check` on PRs and `main`.
- `.github/workflows/public-export.yml`: manual export snapshot artifact for release prep.

## PR Review Loop Strategy

Use `pr-review-loop` in both repos with different checks:

1. **Internal repo PRs**
- Validate architecture and private integration behavior.
- Run `check-templates` and `public:check`.
- Confirm no secret leakage into export-eligible paths.

2. **Public repo PRs**
- Review OSS quality and backward compatibility.
- Keep CI focused on public contract (`check-templates`, tests, docs consistency).

3. **Promotion PRs (internal -> public)**
- Generated from export output only.
- Require explicit label/review: `promotion/public`.
- Must include export manifest (`.public-export-manifest.txt`) in PR description.

## Recommended Release Process

1. Merge feature work in internal repo.
2. Run:
   - `npm run check-templates`
   - `npm run public:check`
3. Export:
   - `node scripts/public-sync.mjs export --target ../agentbootup-public --clean`
4. Or promote automatically:
   - `node scripts/public-promote.mjs --public-repo ../agentbootup-public`
5. Open/verify PR in public repo with only exported changes.
6. Run `pr-review-loop` on the public PR.
7. Tag/release public package.

## Data That Must Stay Internal

- `brain/`
- `memory/`
- `automation/`
- `.ai/`
- internal-only `.claude/.gemini/.codex` runtime state
- any API keys, inbox registries, local machine paths, or operational logs

## Operational Notes

- Treat policy updates as high-risk changes; require maintainer review.
- Keep private skills in internal-only roots.
- If a skill becomes reusable, move it intentionally into export-eligible roots.
