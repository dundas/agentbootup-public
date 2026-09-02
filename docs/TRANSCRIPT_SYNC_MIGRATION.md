# Transcript Sync Key Migration

## Current Format

New `sync-transcripts` writes files under:

```text
.agentbootup-transcripts/brain_transcripts/<agent_id>/<cli>/<session_id>.<ext>
```

Metadata sits beside the transcript as `<session_id>.meta.json` and includes:

- `storage_key`: `<agent_id>/<cli>/<session_id>`
- `agent_id`
- `cli`
- `project_path`: the legacy normalized absolute path key for compatibility
- `source_machine.hostname`
- `source_machine.machine_id` when the network config provides one

This makes the stable brain identity (`agent_id`) the aggregation key, so the same brain can sync from multiple machines without fragmenting by home directory or checkout path.

## Legacy Format

Older sync runs wrote files under:

```text
.agentbootup-transcripts/brain_transcripts/<agent_id>/<cli>/<project_path>/<session_id>.<ext>
```

where `project_path` was derived from the absolute checkout path. Readers keep supporting this layout while migration is in progress.

## Migration Plan

1. Deploy readers that handle both layouts.
2. Deploy writers that produce the new `agent_id/cli/session_id` layout.
3. Backfill old stores by copying each legacy transcript and metadata file up one level into `<agent_id>/<cli>/` when no same-session file already exists.
   The first sync run after writer rollout will re-upload already-synced legacy transcripts into the flat layout because the migration guard only skips legacy state once the flat transcript and metadata pair exists. Expect a one-time `uploaded=N` spike before later runs settle back to `skipped=N`.
4. Keep the original legacy files until downstream consumers confirm they no longer read `project_path` directories.
5. After consumer cutover, delete legacy path-keyed directories in a separate cleanup.
