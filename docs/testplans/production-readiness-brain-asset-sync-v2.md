# Production Readiness: brain-asset-sync v2 Features

**Generated:** 2026-03-09
**Package version:** agentbootup v0.8.12
**Production Environment:** npm public registry
**Rollback Procedure:** `npm deprecate agentbootup@0.8.12 "<reason>"` + publish patched `0.8.13` within hours
**Responsible:** Engineering Lead

---

## Executive Summary

**Features:**
1. `machine_info` metadata (hostname, OS, platform) added to brain asset sync payloads and transcript sync payloads — sent to agentbootup server on every sync cycle (IP excluded — PII under GDPR/CCPA)
2. `maybeAutoPushNetworkConfig` — daemon auto-pushes `agentbootup.json` to server when running at the network root and the config has changed (mtime-deduped)

**User Impact:**
- Feature 1: **All users** running `agentbootup daemon` (background, silent, every sync cycle)
- Feature 2: **Network admins only** — users with `role: "network"` in `agentbootup.json` where daemon `projectRoot === networkRoot`

**Go/No-Go Criteria:**
- All Critical stories pass
- PII disclosure resolved (IP address in `machine_info`)
- Pre-existing doctor test failures fixed or explicitly accepted
- Unit tests written and passing for both new features

---

## PII Decision (Resolved 2026-03-09)

**Decision:** Strip `ip` from `machine_info`. Keep `hostname`.

**Rationale:**
- `ip` is PII under GDPR/CCPA. It adds no attribution value that `machine_id` (stable UUID) doesn't already provide. Removed.
- `hostname` is device metadata. Useful for distinguishing "MacBook vs Mac mini vs cloud server" in server-side logs. On cloud servers it's non-identifying (e.g. `fly-machine-abc123`). Kept.
- `machine_id` alone is sufficient for machine identity and dedup.

**Required code change before publish:**
- [x] Remove `ip` field from `getMachineInfo()` return value in `lib/machine-id/machine-id.js`
- [x] Update `machine_info` type/JSDoc to reflect `ip` removal
- [x] Verify no server-side code depends on `machine_info.ip` — confirmed clean

**Reference:** `docs/MULTI_MACHINE_GUIDE.md` — machine_id vs machine_info section

---

## User Stories & Acceptance Criteria

### Critical Stories (Must Pass for Launch)

---

#### 1. machine_info included in brain asset push payload

**As a** network administrator
**I want** each brain asset push to include machine metadata
**So that** I can identify which machine synced which files on the server side

**Acceptance Criteria:**
- [ ] Every call to `/v1/brain-assets/:brainId/push` includes `machine_id` and `machine_info` in the JSON body
- [ ] `machine_info` contains `hostname`, `os_type`, `os_release`, `platform` — **`ip` field removed**
- [ ] `machine_info` is collected once per sync batch, not per file
- [ ] If OS calls fail (sandboxed/containerized), `machine_info` fields degrade gracefully (empty strings / null) and sync does not abort
- [ ] `machine_id` is a valid UUID matching `~/.agentbootup/machine-id`

**Test Steps:**
1. Mock `fetch` in unit test
2. Trigger `syncPendingFiles()` with one pending file
3. Assert captured request body contains `machine_id` (UUID) and `machine_info` object
4. Assert sync completes successfully

**Tests Added:** `tests/daemon/machine-id.test.ts` — covers `machine_info` shape and graceful degradation

---

#### 2. machine_info graceful degradation in restricted environments

**As a** developer running agentbootup in a container or sandboxed CI environment
**I want** the daemon to continue syncing even if OS metadata calls fail
**So that** my workflow is not broken by environments without full OS access

**Acceptance Criteria:**
- [ ] If `getMachineInfo()` throws internally, it returns `{ hostname: '', os_type: '', os_release: '', platform: '' }` — not an exception
- [ ] Sync batch continues with degraded `machine_info` — does not abort or retry
- [ ] No unhandled promise rejection from `getMachineInfo()` failure

**Test Steps:**
1. Mock `os.hostname()` to throw
2. Call `getMachineInfo()`
3. Assert returns empty-string defaults, does not throw

**Tests Added:** `tests/daemon/machine-id.test.ts` — covers error path and empty-string fallback

---

#### 3. maybeAutoPushNetworkConfig fires only at network root

**As a** network admin
**I want** my `agentbootup.json` auto-pushed when I update it
**So that** project brains receive config updates without a manual `agentbootup network push`

**Acceptance Criteria:**
- [ ] `maybeAutoPushNetworkConfig` calls `pushNetworkConfig` when `projectRoot === networkRoot` and `agentbootup.json` mtime has changed
- [ ] `maybeAutoPushNetworkConfig` is a no-op when `projectRoot !== networkRoot`
- [ ] `maybeAutoPushNetworkConfig` is a no-op when `getNetworkRoot()` returns null
- [ ] `maybeAutoPushNetworkConfig` is a no-op when `agentbootup.json` has `role !== 'network'`
- [ ] `maybeAutoPushNetworkConfig` is a no-op when `agentbootup.json` does not exist
- [ ] After a successful push, the mtime is cached — a second call with same mtime does NOT push again
- [ ] Path stripping is applied — local `path` fields are removed from `projects[]` before push
- [ ] Log line emitted: `Auto-pushed network config: N project(s)`

**Test Steps:**
1. Create temp dir with `agentbootup.json` (`role: "network"`)
2. Mock `getNetworkRoot()` to return same dir
3. Mock `fetch` to capture push request
4. Call `maybeAutoPushNetworkConfig(apiKey, serverUrl, tempDir)`
5. Assert `fetch` called once with stripped config
6. Call again without changing file — assert `fetch` NOT called again
7. Touch the file (update mtime) — assert `fetch` called again

**Tests Added:** `tests/daemon/brain-asset-sync.test.ts` — covers all acceptance criteria above

---

#### 4. maybeAutoPushNetworkConfig errors do not crash the daemon

**As a** developer
**I want** network config push failures to be swallowed with a log
**So that** the main sync loop is not interrupted by a failed config push

**Acceptance Criteria:**
- [ ] If `pushNetworkConfig` throws (network error, 500, etc.), `maybeAutoPushNetworkConfig` catches and logs via `logError` — does not re-throw
- [ ] Sync loop continues normally after a failed auto-push
- [ ] `lastNetworkConfigMtime` is NOT updated on failure — so the next cycle retries

**Test Steps:**
1. Mock `getNetworkRoot()` to return project dir
2. Mock `fetch` to return 500
3. Call `maybeAutoPushNetworkConfig`
4. Assert no exception propagates
5. Assert `lastNetworkConfigMtime` remains 0 (retry on next cycle)

**Tests Added:** `tests/daemon/brain-asset-sync.test.ts` — covers error swallow and mtime-not-updated behavior

---

### Important Stories (High Priority)

---

#### 5. Auto-push fires on each daemon sync cycle

**As a** network admin
**I want** config changes to be picked up automatically within one sync cycle
**So that** I don't have to restart the daemon after updating `agentbootup.json`

**Acceptance Criteria:**
- [ ] `maybeAutoPushNetworkConfig` is called inside the main sync loop (after file push phase)
- [ ] Verified in `brain-asset-sync.mjs` at line 365 — called unconditionally each cycle

**Test Steps:**
- Code review: confirm call site at line 365 is inside `_doSync()`
- Integration: update `agentbootup.json` on a running daemon and observe log output within one cycle

---

#### 6. machine_info also sent in transcript sync payloads

**As a** network admin
**I want** transcript pushes to also include machine metadata
**So that** I can attribute transcripts to specific machines in multi-machine setups

**Acceptance Criteria:**
- [ ] `transcript-sync.mjs` push payload includes `machine_info` at the request level (not per-chunk)
- [ ] Same graceful degradation as brain asset sync

**Note:** `transcript-sync.mjs:260` already has this — verify it matches the same `getMachineInfo()` call pattern

---

### Nice-to-Have (Can Launch Without)

---

#### 7. machine_info opt-out config flag

**As a** privacy-conscious developer
**I want** to opt out of sending machine metadata
**So that** I control what telemetry leaves my machine

**Acceptance Criteria:**
- [ ] `agentbootup.json` or env var supports `"sendMachineInfo": false`
- [ ] When disabled, `machine_info` is omitted from payloads (or sent as null)

**Note:** Recommended for post-launch if Option B is chosen for PII resolution

---

#### 8. Doctor reports auto-push status

**As a** network admin
**I want** `agentbootup daemon doctor` to report last successful network config push
**So that** I can verify auto-push is working without reading daemon logs

---

## Production Smoke Tests

Run immediately after publishing to npm and installing globally:

### Install & Startup
- [ ] `npm i -g agentbootup@0.8.12` installs without errors
- [ ] `agentbootup daemon status` shows all expected brains online
- [ ] `agentbootup daemon start` starts without crash

### machine_info Payload (Feature 1)
- [ ] Trigger a file sync by touching a tracked file in a brain project
- [ ] On the server side, verify the push request body contains `machine_id` and `machine_info`
- [ ] Verify `machine_info.hostname` matches the machine's actual hostname
- [ ] Verify `machine_info` does NOT contain an `ip` field (removed — PII under GDPR/CCPA)

### Auto-Push Network Config (Feature 2)
- [ ] On a machine with `role: "network"` config, update `agentbootup.json` (add/remove a project)
- [ ] Wait one sync cycle (~30s)
- [ ] Verify daemon log shows `Auto-pushed network config: N project(s)`
- [ ] Verify server received updated config via `agentbootup network pull` on a client machine
- [ ] Verify local `path` fields are NOT present in the pushed payload

### Non-Network-Root No-Op
- [ ] On a project brain (non-network-root), verify `maybeAutoPushNetworkConfig` does NOT fire (no log line)

### Error Resilience
- [ ] Temporarily block network access; verify daemon continues syncing files without crashing
- [ ] Restore network; verify sync resumes

### Regression
- [ ] File sync still works for all registered brains
- [ ] Transcript sync still works
- [ ] `agentbootup brain list` still works
- [ ] `agentbootup network push` still works (manual command unaffected)

---

## Test Coverage Requirements (Before Publish)

| Test | File | Status | Notes |
|---|---|---|---|
| `ip` field absent from `getMachineInfo()` return | `tests/daemon/machine-id.test.ts` | ✅ Written | |
| `machine_info` (no ip) in push payload | `tests/daemon/brain-asset-sync.test.ts` | ✅ Written | Tested via getMachineInfo shape |
| `getMachineInfo` error degradation | `tests/daemon/machine-id.test.ts` | ✅ Written | |
| `maybeAutoPushNetworkConfig` — fires at network root | `tests/daemon/brain-asset-sync.test.ts` | ✅ Written | |
| `maybeAutoPushNetworkConfig` — no-op for non-root | `tests/daemon/brain-asset-sync.test.ts` | ✅ Written | |
| `maybeAutoPushNetworkConfig` — mtime dedup | `tests/daemon/brain-asset-sync.test.ts` | ✅ Written | |
| `maybeAutoPushNetworkConfig` — error swallowed, mtime not updated | `tests/daemon/brain-asset-sync.test.ts` | ✅ Written | |
| Server accepts payload without `ip` field | Smoke test (manual) | ❌ Unverified | Still requires manual server-side verification |
| Doctor stale PID detection | `tests/daemon/doctor.test.ts` | ✅ Fixed | Root cause: test not mocking agentStatus — daemon was live on dev machine |
| Doctor daemon not running | `tests/daemon/doctor.test.ts` | ✅ Fixed | Same root cause — fixed with mock.module isolation |

**Pre-test prerequisites (from adversarial review):**
1. Confirm server schema accepts `machine_info` without `ip` — prevents wasted test effort if server rejects the payload shape
2. Root-cause doctor test failures on `main` branch before attributing to new code
3. Validate dynamic import mock strategy works in bun test before writing `maybeAutoPushNetworkConfig` tests

**Target:** 0 failing tests before publish.

---

## Rollback Plan

### Rollback Decision Criteria
- [ ] Daemon crashes on start for any user after upgrading
- [ ] File sync stops working (regressions in core path)
- [ ] Server rejects payloads with `machine_info` field (schema mismatch — silent failure)
- [ ] Auto-push fires for non-network-root projects (incorrect behavior)
- [ ] Auto-push causes retry storm under server degradation (unbounded retries, no backoff)
- [ ] PII/legal issue identified post-publish

### Rollback Steps
1. `npm deprecate agentbootup@0.8.12 "known issue — please upgrade to 0.8.13"` — immediate warning to all installers
2. Prepare patch: revert the problematic feature in a `0.8.13` branch
3. `npm publish` the patched version
4. Notify users via GitHub release notes

### Post-Rollback Actions
- Document root cause in `memory/daily/YYYY-MM-DD.md`
- File GitHub issue with full reproduction steps
- Add regression test before re-shipping

---

## Sign-Off

- [ ] All critical user stories tested and passed
- [ ] PII decision made and implemented (ip field)
- [ ] All 8 missing/failing tests written and green
- [ ] Production smoke tests executed
- [ ] Rollback plan reviewed

**Ready for Production:** ☐ Yes  ☐ No

**Sign-Off By:**
- Engineering Lead: _________________ Date: _______

---

*Generated by agentbootup production-readiness skill — 2026-03-09*
