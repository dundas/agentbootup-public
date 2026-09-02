# Transcript Archive Runbook

This runbook covers archive-v2 backup, verification, restore, and safe offload planning in agentbootup 0.8.28. It does not authorize transcript deletion: production is currently `PAUSE`, and `offload --apply` is hard-disabled.

## Mental model

- **Legacy sync** supports synchronization/search workflows. Its v1 objects are `legacy_unverified` and are not deletion authority.
- **Archive backup** creates an immutable, hash-bound generation, commits it, and reads the complete committed bytes back through the restore endpoint. It runs without the daemon.
- **Restore** materializes exact verified bytes into the analysis cache, an explicit directory, or—only for a supported provider layout—the provider's native root.
- **Offload** is explicit-only. The current command produces a report of potential space and blockers; nothing automatically expires or deletes local transcripts.

## Enable backup safely

Archive upload is disabled by default. The global config path is `~/.agentbootup/config.json`; `AGENTBOOTUP_CONFIG_FILE` can select a different file. Values inside that file supply policy defaults. Command flags then narrow the operation and `--yes` can satisfy upload consent for that invocation. Never store API keys in this file for examples or automation; use the normal encrypted login flow or injected secrets.

```json
{
  "transcripts": {
    "capture": "manual",
    "archive": { "enabled": true },
    "consent": { "upload": "ask" },
    "localRetention": { "mode": "keep_all", "minClosedAgeHours": 24 }
  }
}
```

Only `keep_all` is supported. `capture` may be `manual` or `continuous`, but capture mode does not grant upload consent and neither setting enables deletion. `AGENTBOOTUP_ARCHIVE_LEDGER_FILE` overrides the local ledger path for controlled testing/operations; `AGENTBOOTUP_TRANSCRIPTS_DIR` is the raw analysis-cache override used by doctor and brain restore.

## Operator workflow

```bash
# Metadata-only preview: no transcript content read, credentials, or upload
agentbootup transcripts backup --all --dry-run

# Upload all discovered, mapped providers; --yes records upload consent
agentbootup transcripts backup --all --yes

# Inspect local/remote state, then force committed-storage hash reads
agentbootup transcripts status --all
agentbootup transcripts verify --all --deep

# Clean-machine analysis restore; specify a brain if several are authorized
agentbootup transcripts restore --all --brain <brain-id> --output-dir ./transcript-analysis

# One session, or provider-native restore where its layout is supported
agentbootup transcripts restore --session <session-id> --brain <brain-id> --output-dir ./analysis
agentbootup transcripts restore --session <session-id> --brain <brain-id> --cli codex --native
```

Backup prompts on the first content upload unless consent was already granted or `--yes` is supplied. Restore never overwrites different content: collisions are preserved under deterministic version-suffixed names. A partial publication exits nonzero and is safe to retry.

For automation, add `--json`. Stdout contains exactly one JSON value; progress and diagnostics use stderr. Check both the process exit code and top-level/per-result states:

```bash
agentbootup transcripts verify --all --deep --json
agentbootup transcripts offload --older-than 30d --dry-run --json
```

| Exit | Meaning |
| ---: | --- |
| 0 | Every selected operation succeeded |
| 1 | Internal or local I/O failure |
| 2 | Usage, mapping, consent, discovery, or an unscoped offload apply |
| 3 | Authentication or authorization failure |
| 4 | Archive version not found |
| 5 | Conflict or source changed |
| 6 | Upstream failure after bounded retries |
| 7 | Hash, size, restore, deep verification, durability failure, or scoped `OFFLOAD_APPLY_DISABLED` |
| 124 | Timeout after bounded retries |

## States and durability

`local_only` and `changed_since_backup` need a successful backup of the current bytes. `remote_committed` means an immutable remote generation exists. `restore_verified` means the client performed a complete hash/size-matched readback. `blocked_durability` means content evidence exists but storage policy is insufficient. `blocked_active` means age or harness-state safety could not be proven. `legacy_unverified` and `inventory_present_unverified` are discoverable metadata, not restore or eviction authority. `eviction_eligible` and `offloaded` are schema states reserved for a future qualified apply implementation; this release cannot create them through the CLI.

Supported backup/status/verify/analysis-restore providers are Claude Code, Codex, Cursor, Gemini, and mech-run. Native restore additionally requires a recognized safe provider layout. The v1 offload policy would consider only Claude Code and Codex standalone JSONL, and even those remain retained while the production verdict is `PAUSE`.

## Offload safety

```bash
# Safe and explicit: reports selected/retained bytes and blockers
agentbootup transcripts offload --older-than 30d --dry-run

# Intentionally fails with OFFLOAD_APPLY_DISABLED; deletes nothing
agentbootup transcripts offload --older-than 30d --apply --yes
```

No schedule, daemon, config value, or `--yes` override can enable apply. A future release must require an explicit scope and confirmation, a fresh unexpired plan, a stable regular file inside its trusted root, no symlink/hard link or concurrent writer, a stopped harness, an exact current manifest/receipt/storage-generation binding, fresh full restore verification, versioned and independently replicated blobs, recoverable metadata, effective retention/export/account-closure policy, and a reviewed production `PROCEED` verdict. Files must be deleted individually; recursive deletion and unresolved globs are forbidden.

## Production recovery and incident response

The current production evidence is in [TRANSCRIPT_ARCHIVE_PRODUCTION_EVIDENCE.md](TRANSCRIPT_ARCHIVE_PRODUCTION_EVIDENCE.md). The unresolved blockers are independent catalog backup and metadata-loss restore, runtime-bound object versioning/replication/checksum evidence, effective retention and quota policy, non-payment/account-closure grace and export, and provider-by-provider production restore drills. Each unresolved property blocks local offload.

Before a release, record the current Fly release/image and rollback target, confirm there is no concurrent deploy, and run the sanitized production verifier. Reachability is not durability evidence:

```bash
node scripts/verify-transcript-archive-production.mjs \
  --server-url https://agentbootup.fly.dev \
  --brain <authorized-brain-id> \
  --json
```

If verification, canary, or soak fails: stop rollout; keep offload apply disabled; preserve every local source and the last committed remote generation; capture sanitized release/check IDs; roll back the server if the new release caused the regression; repair catalog/blob reachability without deleting remote generations; rerun deep verification and a clean-machine restore before resuming. Do not treat Fly volume snapshots alone as an independent metadata-recovery proof.

## Test and release gates

Run the focused checks first, then the full package gates:

```bash
NODE_ENV=test AGENTBOOTUP_ALLOW_TEST_SESSION=1 bun test tests/transcript-archive/ src/server/tests/archive-v2*.test.ts
bun run smoke:transcript-archive
bun run soak
npm test
node scripts/check-packed-runtime-adapters.mjs
bun run public:check
bun run check-templates
```

The soak must cover interrupted multipart upload and resume, bounded concurrency/pagination, server replacement over durable backing state, catalog reconstruction, no duplicate logical versions, deep verification, exact clean restore, and privacy scanning. Publication additionally requires installing the packed or published tarball in a clean temporary home and importing every shipped archive runtime module.
