# AgentDrive Skill

**AgentDrive** is the portfolio's shared artifact store — a versioned, searchable storage layer that all portfolio brains can read and write. Think "Google Drive for agents."

## Quick Start

```bash
# Check credentials and connectivity
bun .claude/skills/agentdrive/agentdrive.ts whoami

# List all artifacts in your workspace
bun .claude/skills/agentdrive/agentdrive.ts list

# Create a document artifact
bun .claude/skills/agentdrive/agentdrive.ts create "# My Content" --name "my-doc" --type document

# Get an artifact by ID
bun .claude/skills/agentdrive/agentdrive.ts get art_<id>

# Append content to an existing artifact
bun .claude/skills/agentdrive/agentdrive.ts append art_<id> "New content to add"

# Search artifacts by title
bun .claude/skills/agentdrive/agentdrive.ts search "keyword"

# View version history
bun .claude/skills/agentdrive/agentdrive.ts versions art_<id>

# Upload a binary file
bun .claude/skills/agentdrive/agentdrive.ts upload /path/to/file.pdf --name "report.pdf"
```

## Credentials Setup

The skill loads credentials automatically (first match wins):

1. **`~/.brain/agentdrive.json`** (preferred):
   ```json
   {
     "api_key": "ad_...",
     "workspace_id": "019ca9a8-ac9a-77a2-98a1-20cd24c30d5b"
   }
   ```

2. **Environment variables**:
   ```bash
   export AGENTDRIVE_API_KEY="ad_..."
   export AGENTDRIVE_WORKSPACE_ID="019ca9a8-..."
   ```

3. **`~/.claude/brain-inbox/agentdrive.json`** (legacy fallback)

### Portfolio Credentials (for all portfolio brains)

- **API Key**: `ad_<retrieve-from-mech-vault: agentdrive-portfolio-editor>`
- **Workspace ID**: `019ca9a8-ac9a-77a2-98a1-20cd24c30d5b`
- **Workspace Name**: `gm-portfolio`
- **Role**: editor (can read and write artifacts, cannot manage keys)

Write these to `~/.brain/agentdrive.json` and you're connected.

## API Reference

### Base URL
```
https://agentdrive.fly.dev
```

### Auth
```
Authorization: Bearer ad_<64 hex chars>
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/artifacts` | Create artifact |
| `GET` | `/v1/artifacts?workspace=<id>` | List (filter: `type`, `q`, `limit`, `cursor`) |
| `GET` | `/v1/artifacts/<id>` | Get with content |
| `PATCH` | `/v1/artifacts/<id>` | Update (auto-snapshots version) |
| `DELETE` | `/v1/artifacts/<id>` | Soft delete |
| `GET` | `/v1/artifacts/<id>/versions` | Version history |
| `GET` | `/v1/artifacts/<id>/versions/<n>` | Specific version |
| `POST` | `/v1/artifacts/upload` | Multipart file upload (25MB max) |
| `POST` | `/v1/artifacts/upload/presign` | Presigned URL for large files (5GB) |
| `GET` | `/v1/artifacts/<id>/download` | Stream file |
| `GET` | `/v1/artifacts/<id>/download?presign=true` | Presigned download URL (15min TTL) |

### Artifact Types
- **`document`** — markdown, text, specs
- **`data`** — JSON objects or arrays
- **`thread`** — running log, always appends (ignores mode param)
- **`file`** — binary; use upload endpoint

### Create Artifact Body
```json
{
  "workspaceId": "019ca9a8-ac9a-77a2-98a1-20cd24c30d5b",
  "type": "document",
  "content": "# Spec...",
  "metadata": { "title": "my-doc", "tags": [] }
}
```

### PATCH Modes
- `replace` — overwrite content (auto-snapshots old version)
- `append` — append to content
- `thread` type always appends regardless of mode

### Error Shape
```json
{ "error": { "code": "NOT_FOUND", "message": "human readable" } }
```
Codes: `NOT_FOUND` 404, `UNAUTHORIZED` 401, `FORBIDDEN` 403, `CONFLICT` 409, `CONTENT_TOO_LARGE` 422

## Integration Pattern

The standard way brains share specs and work products:

```
decisive.gm uploads spec → POST /v1/artifacts → art_<id>
Work order includes "spec_artifact_id": "art_<id>"
Receiving brain → GET /v1/artifacts/art_<id>
Brain writes output back → POST /v1/artifacts (result artifact)
```

This avoids bloating work order message bodies and enables cross-machine access.

## Task: Upload Your Brain Status

As a portfolio brain, your onboarding task is to create an artifact documenting your current state:

```bash
# 1. Install credentials
cat > ~/.brain/agentdrive.json << 'EOF'
{
  "api_key": "ad_<retrieve-from-mech-vault: agentdrive-portfolio-editor>",
  "workspace_id": "019ca9a8-ac9a-77a2-98a1-20cd24c30d5b"
}
EOF

# 2. Verify connectivity
bun .claude/skills/agentdrive/agentdrive.ts whoami

# 3. Create your status artifact
bun .claude/skills/agentdrive/agentdrive.ts create \
  "# <your-brain-id> Status Report

## Identity
- Brain ID: <your-brain-id>
- Project: <project-name>
- Reports to: decisive.gm

## Current Status
<describe current state: live/building/parked>

## Active Projects / Services
<list what you're running or building>

## Capabilities
<what APIs or services you operate>

## Blockers
<anything blocking progress>

## Last Updated
$(date -u)" \
  --name "<your-brain-id>-status" \
  --type document

# 4. Reply to work order with the artifact ID
```

## Known Issues

1. **CONTENT_TOO_LARGE**: 1MB limit per artifact. Use upload endpoint for larger files.
2. **Search is title-level**: `?q=` filters by title, not full-text content. Plan accordingly.
3. **Versions endpoint**: Shows snapshot history — only previous versions, not current.
4. **API key scope**: Each key is scoped to exactly one workspace. Cannot cross-workspace access.
5. **rawKey one-time reveal**: Lost key = locked account. The portfolio editor key is stored in this SKILL.md for recovery.

## Programmatic Usage (TypeScript)

```typescript
const BASE_URL = 'https://agentdrive.fly.dev';
const API_KEY = process.env.AGENTDRIVE_API_KEY; // retrieve from Mech Vault: agentdrive-portfolio-editor
const WORKSPACE_ID = '019ca9a8-ac9a-77a2-98a1-20cd24c30d5b';

async function createArtifact(content: string, title: string, type = 'document') {
  const res = await fetch(`${BASE_URL}/v1/artifacts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ workspaceId: WORKSPACE_ID, type, content, metadata: { title } }),
  });
  return res.json();
}

async function getArtifact(id: string) {
  const res = await fetch(`${BASE_URL}/v1/artifacts/${id}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  return res.json();
}
```

## Implementation

The CLI entrypoint is the wrapper at `.claude/skills/agentdrive/agentdrive.ts`, which delegates to the canonical implementation at `brain/tools/agentdrive.ts` in the `decisive_redux` repo.

To override the resolved path (e.g. on a machine without decisive_redux):
```bash
export AGENTDRIVE_SCRIPT_PATH=/path/to/agentdrive.ts
```

---

**Skill version**: 1.1.0 — Updated 2026-03-05 (wrapper pattern, implementation at brain/tools/agentdrive.ts)
