# PRD-0052e M0-H: Hermes Profile Feasibility Spike

**Status:** Task 1.3 complete; approved on dialectical coach turn 3
**Captured:** 2026-07-29
**Decision:** `continue` with mandatory capture filtering and engine-safe database capture
**Scope:** Time-boxed Task 1.3 spike only; this does not qualify an OS lane, a capture
strategy, or production support.

## Safety Boundary and Environment

The probe used only synthetic state under:

`/private/tmp/hermes-m0h-spike-20260729-t3/home`

It did not inspect or write the user's Hermes home, invoke the installed user-level
`hermes` executable, use credentials, contact providers, or start a real gateway or cron
service. The strings placed in `.env` and `auth.json` were synthetic sentinels.

| Property | Observed value |
|---|---|
| pinned source worktree | `/private/tmp/hermes-v019-spike-src` |
| source `HEAD` | `3ef6bbd201263d354fd83ec55b3c306ded2eb72a` |
| `hermes_cli/profiles.py` SHA-256 | `dbfd34e5852e61ea501669d8b5db99e6a7e119b8ce4975e2211ea9546de1ac7b` |
| `hermes_cli/backup.py` SHA-256 | `1bcef6f736f1d52055837789f24becdba4a670f0a1abb5ac9973b1a1a7306f35` |
| execution interpreter | Python 3.13.7 |
| host | macOS 14.5 (23F79), arm64 |

The source revision was checked immediately before execution:

```text
$ git -C /private/tmp/hermes-v019-spike-src rev-parse HEAD
3ef6bbd201263d354fd83ec55b3c306ded2eb72a
```

Pinned modules were executed with both `HERMES_HOME` and `PYTHONPATH` explicit, for
example:

```text
env HERMES_HOME=/private/tmp/hermes-m0h-spike-20260729-t3/home \
  PYTHONPATH=/private/tmp/hermes-v019-spike-src \
  python3.13 -c "from hermes_cli.profiles import export_profile; ..."
```

## Synthetic Layout

The installation contained two source profiles:

```text
home/                              default profile
  config.yaml, SOUL.md
  .env, auth.json                  synthetic secret sentinels
  state.db                         default database canary
  gateway.pid, gateway_state.json,
  processes.json                   synthetic machine-local sentinels
  memories/, skills/, sessions/, cron/
  profiles/coder/                  named profile
    config.yaml, SOUL.md
    .env, auth.json                distinct synthetic secret sentinels
    state.db                       distinct named-profile database canary
    gateway.pid, gateway_state.json,
    processes.json                 distinct machine-local sentinels
    memories/, skills/, sessions/, cron/
```

Every portable directory contained a profile-distinct canary. The SQLite databases used
a `canary(value)` table. A later bounded writer probe switched the named database to WAL
mode, committed `CODER_LIVE_WAL_CANARY`, and held the connection open during export.

## Observations

### Profile export membership

Pinned `export_profile()` produced:

| Item | default export | named `coder` export |
|---|---:|---:|
| config, SOUL, memory, skill, session file, cron jobs | included | included |
| sibling profile | excluded | excluded |
| `.env`, `auth.json` | excluded | excluded |
| `state.db` | excluded | included |
| `gateway.pid`, `gateway_state.json`, `processes.json` | excluded | included |
| live `state.db-wal` / `state.db-shm` | n/a | included while writer was open |

The executed run wrote the archives to
`/private/tmp/hermes-m0h-spike-20260729-t3/{default,coder,coder-live}.tar.gz`.
Their checksums were:

```text
5f946c5f779a72de2a5790f3360837225771a38fd6757419336bedf67a98e05c  default.tar.gz
334cb7db5f0a072ed30ed54b88b4a4f0dc2346a7ea5c131838089209c21f90cb  coder.tar.gz
3a9ea7ede08304ea61c00a82d2f72972a31fa7c1c6d1a03d6fe02d107560c18e  coder-live.tar.gz
```

The exact sorted member listings from that same run were:

```text
default:
default
default/SOUL.md
default/config.yaml
default/cron
default/cron/jobs.json
default/memories
default/memories/canary.md
default/sessions
default/sessions/canary.json
default/skills
default/skills/canary
default/skills/canary/SKILL.md

coder:
coder
coder/SOUL.md
coder/config.yaml
coder/cron
coder/cron/jobs.json
coder/gateway.pid
coder/gateway_state.json
coder/memories
coder/memories/canary.md
coder/processes.json
coder/sessions
coder/sessions/canary.json
coder/skills
coder/skills/canary
coder/skills/canary/SKILL.md
coder/state.db

coder-live:
coder
coder/SOUL.md
coder/config.yaml
coder/cron
coder/cron/jobs.json
coder/gateway.pid
coder/gateway_state.json
coder/memories
coder/memories/canary.md
coder/processes.json
coder/sessions
coder/sessions/canary.json
coder/skills
coder/skills/canary
coder/skills/canary/SKILL.md
coder/state.db
coder/state.db-shm
coder/state.db-wal
```

This proves useful native sibling isolation and filename-level exclusion of `.env` and
`auth.json`, but it does not prove general secret exclusion: the contents of allowed
files were not scanned or classified. Later probes must inspect allowed-file contents
for secret material before treating an archive as safe. Profile export is not itself
the PRD restore payload:

1. default and named profiles have materially different membership;
2. default export omits the canonical database;
3. named export copies machine-local runtime state that FR-13 forbids restoring; and
4. named export copies SQLite files through `shutil.copytree`, not the safe SQLite backup
API used by full backup.

### Profile import behavior

The default archive imported successfully only when renamed to a named destination
(`restored-default`). The pinned importer explicitly rejects importing as `default`.
The named archive imported as `restored-coder`.

Before the deliberate WAL mutation, the original sibling's sampled hashes were
unchanged across both initial imports:

```text
79e3fd9478bda2d20251415f1a5778b432a9eb26dd34aee2ce25ea7014f5b0cb  coder/config.yaml
dc58d062d95e8acdf8154a1c024719113d477a40cb106b5ee034b5aca6f117fc  coder/state.db
```

The WAL writer then deliberately inserted `CODER_LIVE_WAL_CANARY`. After the writer
connection closed and SQLite checkpointed the transaction, the final/current
`coder/state.db` hash was
`98ed3cb6f9f5509df5f45301d5b9bdc828794fbb28f15f3bb7c2fbcd3635a23f`. The hash change
therefore belongs to the intentional mutation, not to either import.

The imported named database passed `PRAGMA integrity_check` and returned its synthetic
canary. During the WAL writer probe, the archive contained `state.db`, `state.db-wal`,
and `state.db-shm`; importing that archive also passed integrity checking and returned
both `CODER_DB_CANARY` and `CODER_LIVE_WAL_CANARY`.

That single favorable concurrent-write result is not proof that raw three-file copying is
safe across all WAL timing windows. Product capture must use an engine-safe database
snapshot and independently verify integrity, schema, and canaries.

### Writer and quiescence scope

Pinned source establishes:

- `hermes_cli/profiles.py:4-9` defines each profile as its own `HERMES_HOME`.
- `cron/jobs.py:54-65,125-170` routes cron stores per profile through the active
  `HERMES_HOME`/context override.
- `hermes_cli/profiles.py:949-985` shows that a non-multiplex gateway serves one active
  profile, while a multiplex gateway serves the default and every named profile.
- `gateway/run.py:1523-1540,7755-7761,9316-9355` shows a single multiplex process creates
  secondary adapters and scopes turns to each profile.
- `hermes_cli/backup.py:256-283,391-410` uses SQLite's `backup()` API for `.db` files,
  unlike profile export.

Preliminary scope result:

- cron data paths are profile-scoped;
- a non-multiplex selected-profile gateway is plausibly stoppable independently;
- when multiplexing is active, the one gateway process can write state for every served
  profile, so process-level quiescence is installation-wide unless a later probe proves a
  safe per-profile drain/fence;
- CLI, TUI, Desktop/backend, provider, and external-memory writers remain to be censused
  by Tasks 1.7–1.10.

## Preliminary Decision

**`continue`**, but not with native profile export/import as an opaque recovery primitive.

The spike found no reason yet to abandon one-profile-equals-one-brain. Native profile
export provides a useful profile-isolated portable-core source. AgentBootup must,
however:

1. inventory and filter every exported member;
2. reject named-profile PID/state/process files;
3. capture omitted/default and named durable databases through an engine-safe mechanism;
4. implement a dedicated clean-target path for restoring the `default` identity rather
   than relying on native profile import;
5. treat a multiplex gateway as installation-wide for quiescence until stronger evidence
   proves a profile-specific fence; and
6. keep M0-H open until the full ownership/writer census and full-backup comparison choose
   a final strategy.

If the later census cannot safely quiesce all selected-profile writers without losing
sibling availability, or cannot restore the default profile without sibling mutation,
M0-H must change to `redesign` or `stop`.

## Commands and Validation

The following is the canonical sequence actually executed for this evidence. `ROOT` is
an input and the sequence refuses to run if it already exists. A future replay must set
`ROOT` to a different fresh disposable path; reusing the retained evidence root will
fail before writing. `SRC` must remain an exact checkout of the pinned commit.

```bash
ROOT=/private/tmp/hermes-m0h-spike-20260729-t3 \
SRC=/private/tmp/hermes-v019-spike-src \
bash -s <<'SH'
set -eu
: "${ROOT:?set ROOT to a fresh disposable path}"
: "${SRC:?set SRC to the pinned Hermes source worktree}"
HOME_DIR="$ROOT/home"
PINNED_COMMIT=3ef6bbd201263d354fd83ec55b3c306ded2eb72a
test "$(git -C "$SRC" rev-parse HEAD)" = "$PINNED_COMMIT"
test ! -e "$ROOT"
mkdir -p "$HOME_DIR"

env HERMES_HOME="$HOME_DIR" PYTHONPATH="$SRC" ROOT="$ROOT" \
  python3.13 - <<'PY'
import hashlib
import json
import os
import sqlite3
import tarfile
from pathlib import Path

from hermes_cli.profiles import export_profile, import_profile

root = Path(os.environ["ROOT"])
home = Path(os.environ["HERMES_HOME"])
coder = home / "profiles" / "coder"

def put(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")

def make_profile(path: Path, label: str) -> None:
    put(path / "config.yaml", f"profile: {label}\n")
    put(path / "SOUL.md", f"{label} soul\n")
    put(path / ".env", f"SYNTHETIC_{label.upper()}_SECRET=not-real\n")
    put(path / "auth.json", json.dumps({"synthetic": f"{label}-not-real"}))
    put(path / "gateway.pid", "424242\n")
    put(path / "gateway_state.json", json.dumps({"synthetic": label}))
    put(path / "processes.json", json.dumps({"synthetic": label}))
    for rel in (
        "memories/canary.md",
        "skills/canary/SKILL.md",
        "sessions/canary.json",
        "cron/jobs.json",
    ):
        put(path / rel, f"{label}:{rel}\n")
    with sqlite3.connect(path / "state.db") as db:
        db.execute("CREATE TABLE canary(value TEXT NOT NULL)")
        db.execute("INSERT INTO canary VALUES (?)", (f"{label.upper()}_DB_CANARY",))
        db.commit()

def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()

def members(path: Path) -> list[str]:
    with tarfile.open(path, "r:gz") as archive:
        return sorted(member.name for member in archive.getmembers())

def validate_db(path: Path, expected: list[str]) -> None:
    with sqlite3.connect(path) as db:
        assert db.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        actual = [row[0] for row in db.execute("SELECT value FROM canary ORDER BY rowid")]
        assert actual == expected, (actual, expected)

make_profile(home, "default")
make_profile(coder, "coder")
baseline = {
    "config": sha(coder / "config.yaml"),
    "state": sha(coder / "state.db"),
}
default_archive = Path(export_profile("default", str(root / "default.tar.gz")))
coder_archive = Path(export_profile("coder", str(root / "coder.tar.gz")))
default_members = members(default_archive)
coder_members = members(coder_archive)
for listing in (default_members, coder_members):
    assert not any(Path(name).name in {".env", "auth.json"} for name in listing)
assert not any(name.startswith("default/profiles/") for name in default_members)
assert not any(name.startswith("coder/profiles/") for name in coder_members)
assert "default/state.db" not in default_members
assert "coder/state.db" in coder_members
assert "coder/gateway.pid" in coder_members

import_profile(str(default_archive), "restored-default")
import_profile(str(coder_archive), "restored-coder")
after_import = {
    "config": sha(coder / "config.yaml"),
    "state": sha(coder / "state.db"),
}
assert after_import == baseline
validate_db(home / "profiles/restored-coder/state.db", ["CODER_DB_CANARY"])

writer = sqlite3.connect(coder / "state.db")
assert writer.execute("PRAGMA journal_mode=WAL").fetchone() == ("wal",)
writer.execute("INSERT INTO canary VALUES ('CODER_LIVE_WAL_CANARY')")
writer.commit()
live_archive = Path(export_profile("coder", str(root / "coder-live.tar.gz")))
live_members = members(live_archive)
for required in ("coder/state.db", "coder/state.db-wal", "coder/state.db-shm"):
    assert required in live_members
import_profile(str(live_archive), "live-restore")
validate_db(
    home / "profiles/live-restore/state.db",
    ["CODER_DB_CANARY", "CODER_LIVE_WAL_CANARY"],
)
writer.close()
validate_db(coder / "state.db", ["CODER_DB_CANARY", "CODER_LIVE_WAL_CANARY"])
final_hashes = {
    "config": sha(coder / "config.yaml"),
    "state": sha(coder / "state.db"),
}
assert final_hashes["config"] == baseline["config"]
assert final_hashes["state"] != baseline["state"]

print("root", root)
print("archives", json.dumps({
    "default": str(default_archive),
    "coder": str(coder_archive),
    "coder_live": str(live_archive),
}, sort_keys=True))
print("baseline", json.dumps(baseline, sort_keys=True))
print("after_import", json.dumps(after_import, sort_keys=True))
print("final_hashes", json.dumps(final_hashes, sort_keys=True))
print("default_members", json.dumps(default_members))
print("coder_members", json.dumps(coder_members))
print("live_members", json.dumps(live_members))
PY

shasum -a 256 "$ROOT/default.tar.gz" "$ROOT/coder.tar.gz" "$ROOT/coder-live.tar.gz"
SH
```

The recorded run printed the exact paths, member listings, baseline/import/final hashes,
and three archive checksums shown above. Executed evidence checks included:

- exact `git rev-parse HEAD` of the disposable pinned source worktree;
- `export_profile("default")` and `export_profile("coder")`;
- Python `tarfile` membership inspection for both initial archives and the live-WAL
  archive;
- `import_profile()` into three new synthetic named targets;
- before/after SHA-256 checks of sampled sibling files;
- SQLite `PRAGMA integrity_check` and canary reads after import;
- `git diff --check` and repository status after writing this artifact.

No product code, reusable probe harness, real service, network/provider action, hosted
artifact, or support-matrix row was created.

## Limitations and Required Follow-up

- This was one macOS arm64 source-level execution, not either qualified lane.
- It did not execute the packaged CLI entry point or verified wheel.
- It did not run native full backup/import.
- It did not start or stop real Hermes gateway, cron, TUI, Desktop, or agent writers.
- It did not test external memory providers, aliases, services, malformed archives,
  symlinks, permission failures, large databases, or concurrent mutation beyond one
  SQLite WAL timing.
- Archive listings and synthetic outputs remain local disposable evidence and are not
  committed.
- Tasks 1.4–1.12 must supply the missing lane, harness, complete ownership, full-backup,
  writer, integrity, and final M0-H decision evidence.
