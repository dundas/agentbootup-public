# PRD-0052e M0-H: Writer Census and Quiescence Scope

**Scope:** Task 1.10  
**Result:** PASS — the writer boundary and lifecycle contract are determined;
safe capture requires installation-wide quiescence  
**Support impact:** None. Native lifecycle actuation remains blocked on Task 4.

## Exact execution

- Candidate commit: `a36ef5052b6a3e5915ac891783f36e6c7940633f`
- Workflow run: [30487907970](https://github.com/dundas/agentbootup/actions/runs/30487907970)
- Job: `90698104651` (`Linux amd64 evidence`)
- Result: every step passed, including exact-source verification, the no-egress
  lifecycle model, sanitizer, nine-file staging allowlist, and upload
- Runtime: the Task 1.6 pinned Linux amd64 lane: Hermes `0.19.0`, CPython `3.13.13`,
  Ubuntu image `20260720.247.2`

`scripts/runtime-adapters/hermes-m0h-quiescence-probe.py` verified the exact wheel and
12 source-file digests before producing a 14-row store/writer census and exercising 23
deterministic lifecycle and crash-recovery scenarios. It did not start, inspect, stop,
or resume native services or real Hermes processes. Those implementation checks remain
explicitly blocked.

No live Hermes home was read or written. The disposable Task 1.6 home remained stable.
The structured report contains no local path, PID, command line, environment, profile
content, secret material, runtime filename, or raw journal.

## Why profile-scoped quiescence is unsafe

Hermes profiles have separate `HERMES_HOME` directories, but the pinned source does not
enforce them as a hard write fence:

- `tools/file_tools.py` describes cross-profile protection as a soft guard and permits
  an explicit `cross_profile=True` override.
- `hermes_state.py:SessionDB` documents concurrent writers from gateway, CLI sessions,
  worktree agents, and cron activity sharing one `state.db`.
- `hermes_cli/profiles.py:_profile_bound_backend_pids` documents Desktop
  `serve`/`dashboard` backends that hold SQLite open and write session/WAL/sandbox state
  without appearing in `gateway.pid`.
- `hermes_cli/web_server.py` starts a Desktop cron scheduler and exposes memory reset,
  learning-node edit/delete, session, and cron mutation surfaces.
- `hermes_cli/main.py` permits independent chat, ACP, cron `run`, and cron `tick`
  processes.
- `hermes_cli/profiles.py:profiles_to_serve` proves that one multiplex gateway can serve
  every profile.

There is no filesystem lock honored by every one of those writer paths. Under the stated
same-UID, no-concurrent-adversarial-mutation trust boundary, AgentBootup must therefore
quiesce or positively classify every Hermes process sharing the installation. Unknown,
uninspectable, interactive, or unmanaged writers block capture. Because sibling
profiles are interrupted, explicit sibling-impact consent is mandatory.

Task 1.9 independently established that native full backup walks the installation root.
Task 1.10's writer fence remains installation-wide even if Task 1.12 selects the
narrower profile export plus supplements.

## Captured-store writer census

| Store | Known writer classes | Required disposition |
|---|---|---|
| Core config | management CLI, dashboard, agent surfaces, generic file tools | installation-wide writer fence |
| Identity | management CLI, dashboard, generic file tools | installation-wide writer fence |
| Memory documents | gateway/cron/interactive agents, dashboard, memory plugins, file tools | installation-wide writer fence |
| Skills | skill manager, dashboard, agents, file tools | installation-wide writer fence |
| Hooks | management CLI, dashboard, gateway agents, file tools | installation-wide writer fence |
| Session files | gateway, CLI, TUI, ACP, dashboard, worktree agents | writer fence plus active-lease check |
| Session database | gateway, CLI, TUI, ACP, dashboard, cron/worktree agents | writer fence, then SQLite API |
| Cron definitions | gateway, Desktop, cron CLI/tool, dashboard, external-scheduler webhook | installation-wide writer fence |
| Cron executions | gateway, Desktop, cron CLI, external-scheduler webhook | writer fence, then SQLite API |
| Cron output | gateway, Desktop, cron CLI, external-scheduler webhook | installation-wide writer fence |
| External-memory declaration | management CLI and provider setup | sanitize declaration; payload separate |
| External-memory payload | provider, provider backend, external service | provider-specific; blocked on Task 9 |
| Machine-local runtime | gateway, Desktop, service manager, cron scheduler | observe for lifecycle; exclude from payload |
| Authorization | auth/setup/OAuth/pairing paths | exclude from default payload and evidence |

The external scheduler's `fire_due` path claims and saves a job, creates an execution,
and runs it; it therefore appears in all three mutable cron rows. External provider
payload quiescence is not claimed by this local process census.

## Cron lifecycle

Built-in cron has no independent daemon. The pinned gateway starts the resolved cron
provider in a thread, signals its stop event during gateway shutdown, calls the
provider's `stop`, and cooperatively waits for the thread. A Desktop backend can own an
equivalent scheduler thread.

The recovery rule is consequently:

- record the actual pre-operation owner state;
- stop and drain the owner;
- never issue a separate cron start; and
- resume cron only by resuming an owner that was both originally running and stopped by
  the wrapper.

An external scheduler provider's remote state is outside local qualification and remains
a blocker/disposition.

## Lifecycle and recovery contract

Before any stop, the future adapter must acquire an installation-wide operation lock
outside the payload and atomically journal the installation identity, profile inventory,
process/service identity, actual running state, durable desired state, active work, and
whether the wrapper stopped each component. It must require sibling-impact consent.

Interactive CLI/TUI/ACP sessions, unmanaged Desktop backends, unknown writers,
uninspectable process metadata, supervisor races, or ambiguous state return
`writer_busy_unsupported`; the adapter must not kill or reconstruct them.

For supported service-managed owners, the adapter must use the native manager, await
gateway/cron drain and SQLite close, then require two stable zero-writer observations
before capture. Quiescence never permits a raw SQLite copy; Task 1.11 still owns
engine-safe database proof.

Resume is authorized only when both `originallyRunning=true` and
`stoppedByWrapper=true`. Originally stopped, crashed, merely registered, or
desired-running-but-not-actually-running components must never start. Resume ambiguity
or failure returns `safe_stopped`.

The modeled journal phases are:

`observed → quiescing → quiesced → capturing → captured → resuming → complete`

The 23 scenarios cover stopped/running owners, multiple gateways, multiplexing,
Desktop and interactive writers, standalone cron, cross-profile and unknown writers,
drain/supervisor failures, partial resume, and a crash at every journal phase. This
proves the authorization and fail-closed model only—not native service actuation.

## Restore-oracle extensions

| Check ID | Status | Evidence or dependency |
|---|---|---|
| `HERMES-RO-WRITER-CENSUS-001` | pass | pinned source writer classes accounted |
| `HERMES-RO-QUIESCENCE-SCOPE-001` | pass | pinned source requires installation scope |
| `HERMES-RO-QUIESCENCE-ZERO-WRITERS-001` | blocked | Task 4 native implementation |
| `HERMES-RO-QUIESCENCE-STABILITY-001` | blocked | Task 4 native implementation |
| `HERMES-RO-SIBLING-CONSENT-001` | pass | model requires consent before stopping |
| `HERMES-RO-GATEWAY-DRAIN-001` | blocked | Task 4 native implementation |
| `HERMES-RO-CRON-DRAIN-001` | blocked | Task 4 native implementation |
| `HERMES-RO-PROCESS-STATE-RESTORE-001` | blocked | Task 4 native implementation |
| `HERMES-RO-STOPPED-NOT-STARTED-001` | pass | negative-start tripwire is clear |
| `HERMES-RO-QUIESCE-CRASH-RECOVERY-001` | pass | journal authorization model complete |
| `HERMES-RO-UNKNOWN-WRITER-FAIL-CLOSED-001` | pass | unknown/uninspectable writers block |

Statuses use only `pass` or `blocked`. The registry remains draft until Task 2.

## Reviewed artifact

Artifact `8738443633`, `hermes-m0h-linux-amd64-30487907970-1`, has digest
`sha256:bb31b389478b47d10587d9eab4dff2d2c8adb09f3d729a7b3202fa343da476b3`,
reported a compressed size of 14,145 bytes, and expires on 2026-08-05. Independent
download found exactly nine regular JSON files. The new `quiescence-report.json`
SHA-256 is
`a638570eb8552bfe42ce4456a1f2ed864a7dfacc526e5cb49de5afb5cc33c218`.
Independent structured and forbidden-material scans were clean.

## Decision

Task 1.10 fixes the M0-H design boundary at installation-wide quiescence with explicit
sibling-impact consent. Built-in cron follows its owning gateway/Desktop lifecycle, and
only components proven originally running and stopped by AgentBootup may resume.

Task 1.10 is complete as source-backed scope and lifecycle-model evidence. It does not
qualify native lifecycle actuation, macOS launchd, external scheduler state, or external
memory payload quiescence, and it does not qualify either support-matrix row.
