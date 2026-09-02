#!/usr/bin/env python3
"""Evidence-only Task 1.11 probe for Hermes SQLite capture semantics."""

from __future__ import annotations

import contextlib
import hashlib
import importlib
import importlib.metadata
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import sys
import tarfile
from types import SimpleNamespace
import zipfile

HERMES_VERSION = "0.19.0"
HERMES_TAG = "v2026.7.20"
HERMES_COMMIT = "3ef6bbd201263d354fd83ec55b3c306ded2eb72a"
HERMES_WHEEL_SHA256 = "bd0bac012aee38a60894781f4597dc29ee7bedb3448540249921f10d3bef327f"
BACKUP_SOURCE_SHA256 = "1bcef6f736f1d52055837789f24becdba4a670f0a1abb5ac9973b1a1a7306f35"
PROFILES_SOURCE_SHA256 = "dbfd34e5852e61ea501669d8b5db99e6a7e119b8ce4975e2211ea9546de1ac7b"
PRIVATE_DIR_MODE = 0o700
PRIVATE_FILE_MODE = 0o600
PROFILE_NAMES = ("default", "atlas", "beacon")
DB_CLASSES = ("session_database", "cron_executions")
DB_ORACLES = (
    "HERMES-RO-DB-INTEGRITY-001",
    "HERMES-RO-DB-SCHEMA-001",
    "HERMES-RO-DB-CANARY-001",
    "HERMES-RO-DB-WAL-001",
    "HERMES-RO-DB-BACKUP-FAIL-CLOSED-001",
    "HERMES-RO-DB-SOURCE-SIDECAR-DISPOSITION-001",
)

EXPECTED = {
    "session_database": {
        "schemaSha256": "603327aab61e6f4f6e0490e25acf52f34ddc6b4fad8f275a04ae0de41e6b6549",
        "objectCount": 43,
        "tables": {"sessions", "messages", "schema_version"},
        "columns": {
            "sessions": {"id", "source", "started_at"},
            "messages": {"id", "session_id", "role", "content", "timestamp"},
            "schema_version": {"version"},
        },
        "indexes": {"idx_sessions_source", "idx_messages_session"},
    },
    "cron_executions": {
        "schemaSha256": "ee3647f0011fe520415c708bc9daae2e2e4764152ada88dd29d53efb29be72df",
        "objectCount": 3,
        "tables": {"executions"},
        "columns": {
            "executions": {
                "id", "job_id", "source", "process_id", "pid",
                "process_started_at", "status", "claimed_at", "started_at",
                "finished_at", "error",
            },
        },
        "indexes": {
            "idx_executions_job_claimed",
            "idx_executions_status_claimed",
        },
    },
}


def refuse(message: str) -> None:
    raise RuntimeError(f"Hermes database probe refused: {message}")


def helpers_module():
    path = Path(__file__).with_name("hermes-m0h-profile-transfer-probe.py")
    spec = importlib.util.spec_from_file_location("hermes_database_helpers", path)
    if spec is None or spec.loader is None:
        refuse("cannot load profile-transfer validation helpers")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HELPERS = helpers_module()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def profile_root(home: Path, name: str) -> Path:
    return home if name == "default" else home / "profiles" / name


def database_path(home: Path, profile: str, db_class: str) -> Path:
    root = profile_root(home, profile)
    return root / ("state.db" if db_class == "session_database" else "cron/executions.db")


def scenario_sidecars(home: Path) -> dict[Path, tuple[int, int, int]]:
    observed = {}
    for profile in PROFILE_NAMES:
        for db_class in DB_CLASSES:
            database = database_path(home, profile, db_class)
            for suffix in ("-wal", "-shm", "-journal"):
                candidate = database.with_name(database.name + suffix)
                if not candidate.exists():
                    continue
                info = candidate.lstat()
                if not candidate.is_file() or candidate.is_symlink():
                    refuse("scenario SQLite sidecar is not a regular file")
                observed[candidate] = (info.st_dev, info.st_ino, info.st_uid)
    return observed


def native_environment(user_home: Path, hermes_home: Path, temp_root: Path) -> None:
    os.environ.update({
        "HOME": str(user_home),
        "HERMES_HOME": str(hermes_home),
        "PATH": "/usr/bin:/bin",
        "TMPDIR": str(temp_root),
        "PYTHONNOUSERSITE": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "HERMES_DISABLE_LAZY_INSTALLS": "1",
        "HTTP_PROXY": "http://127.0.0.1:9",
        "HTTPS_PROXY": "http://127.0.0.1:9",
        "ALL_PROXY": "http://127.0.0.1:9",
        "NO_PROXY": "",
    })


def call_quietly(function, *args):
    stream = io.StringIO()
    with contextlib.redirect_stdout(stream), contextlib.redirect_stderr(stream):
        result = function(*args)
    return result, stream.getvalue()


def verify_runtime(install_root: Path, wheel: Path) -> dict[str, str]:
    if sha256_file(wheel) != HERMES_WHEEL_SHA256:
        refuse("Hermes wheel digest drifted")
    with zipfile.ZipFile(wheel) as archive:
        metadata_names = [
            name for name in archive.namelist()
            if name.endswith(".dist-info/METADATA")
        ]
        record_names = [
            name for name in archive.namelist()
            if name.endswith(".dist-info/RECORD")
        ]
        if len(metadata_names) != 1 or len(record_names) != 1:
            refuse("wheel metadata cardinality drifted")
        metadata = archive.read(metadata_names[0]).decode("utf-8")
        if "\nName: hermes-agent\n" not in f"\n{metadata}" or \
                f"\nVersion: {HERMES_VERSION}\n" not in f"\n{metadata}":
            refuse("wheel package metadata drifted")
        wheel_hashes = {
            "backup": sha256_bytes(archive.read("hermes_cli/backup.py")),
            "profiles": sha256_bytes(archive.read("hermes_cli/profiles.py")),
        }
    if wheel_hashes != {
        "backup": BACKUP_SOURCE_SHA256,
        "profiles": PROFILES_SOURCE_SHA256,
    }:
        refuse("pinned wheel source digest drifted")
    environment_root = (install_root / "env").resolve()
    if Path(sys.prefix).resolve() != environment_root:
        refuse("probe interpreter environment is not the exact install root")
    distribution = importlib.metadata.distribution("hermes-agent")
    if distribution.version != HERMES_VERSION:
        refuse("installed Hermes distribution version drifted")
    installed_hashes = {}
    for source_id, member in (
        ("backup", "hermes_cli/backup.py"),
        ("profiles", "hermes_cli/profiles.py"),
    ):
        installed = Path(distribution.locate_file(member)).resolve()
        if not HELPERS.contained(environment_root, installed):
            refuse("installed Hermes source is outside the exact install root")
        installed_hashes[source_id] = sha256_file(installed)
    if installed_hashes != wheel_hashes:
        refuse("installed Hermes sources differ from the verified wheel")
    return wheel_hashes


def fixture_canaries_present(path: Path, profile: str, db_class: str) -> bool:
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as connection:
        if db_class == "session_database":
            session = connection.execute(
                "SELECT count(*) FROM sessions WHERE id=?", (f"session-{profile}",)
            ).fetchone()[0]
            fixture = connection.execute(
                "SELECT count(*) FROM agentbootup_fixture_canary WHERE profile=?",
                (profile,),
            ).fetchone()[0]
            return session == 1 and fixture == 1
        completed = connection.execute(
            "SELECT count(*) FROM executions "
            "WHERE source='synthetic' AND status='completed' "
            "AND id NOT LIKE 'probe-%'"
        ).fetchone()[0]
        return completed == 1


def open_wal_canary(
    path: Path, profile: str, db_class: str
) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    if connection.execute("PRAGMA journal_mode=WAL").fetchone()[0].lower() != "wal":
        refuse("database did not enter WAL mode")
    connection.execute("PRAGMA wal_autocheckpoint=0")
    connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    if db_class == "session_database":
        connection.executemany(
            "INSERT INTO agentbootup_fixture_canary(profile, value) VALUES (?,?)",
            (
                (f"probe-committed-{profile}", "committed"),
                (f"probe-pair-a-{profile}", "pair-a"),
                (f"probe-pair-b-{profile}", "pair-b"),
            ),
        )
    else:
        seed = connection.execute(
            "SELECT job_id,source,process_id,pid,process_started_at,status,"
            "claimed_at,started_at,finished_at,error FROM executions "
            "WHERE source='synthetic' AND status='completed' LIMIT 1"
        ).fetchone()
        if seed is None:
            refuse("native completed execution fixture drifted")
        connection.executemany(
            "INSERT INTO executions VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (
                (f"probe-committed-{profile}", *seed),
                (f"probe-pair-a-{profile}", *seed),
                (f"probe-pair-b-{profile}", *seed),
            ),
        )
    connection.commit()
    if db_class == "session_database":
        connection.execute(
            "INSERT INTO agentbootup_fixture_canary(profile, value) VALUES (?,?)",
            (f"probe-uncommitted-{profile}", "uncommitted"),
        )
    else:
        connection.execute(
            "INSERT INTO executions VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (f"probe-uncommitted-{profile}", *seed),
        )
    wal = path.with_name(path.name + "-wal")
    if not wal.is_file() or wal.stat().st_size == 0:
        refuse("committed open-writer WAL canary was not retained")
    return connection


def schema_evidence(path: Path, profile: str, db_class: str) -> dict[str, object]:
    uri = f"file:{path}?mode=ro&immutable=1"
    with sqlite3.connect(uri, uri=True) as connection:
        quick = [row[0] for row in connection.execute("PRAGMA quick_check")]
        integrity = [row[0] for row in connection.execute("PRAGMA integrity_check")]
        foreign_keys = connection.execute("PRAGMA foreign_key_check").fetchall()
        schema_rows = connection.execute(
            "SELECT type,name,tbl_name,sql FROM sqlite_master "
            "WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"
        ).fetchall()
        schema_sha256 = sha256_bytes(
            json.dumps(schema_rows, separators=(",", ":")).encode()
        )
        tables = {row[1] for row in schema_rows if row[0] == "table"}
        indexes = {row[1] for row in schema_rows if row[0] == "index"}
        trigger_count = sum(row[0] == "trigger" for row in schema_rows)
        expected = EXPECTED[db_class]
        columns_ok = all(
            required <= {
                row[1] for row in connection.execute(
                    f'PRAGMA table_info("{table}")'
                )
            }
            for table, required in expected["columns"].items()
        )
        if db_class == "session_database":
            native_count = connection.execute(
                "SELECT count(*) FROM sessions WHERE id=?", (f"session-{profile}",)
            ).fetchone()[0]
            fixture_count = connection.execute(
                "SELECT count(*) FROM agentbootup_fixture_canary WHERE profile=?",
                (profile,),
            ).fetchone()[0]
            committed_count = connection.execute(
                "SELECT count(*) FROM agentbootup_fixture_canary "
                "WHERE profile=?", (f"probe-committed-{profile}",)
            ).fetchone()[0]
            uncommitted_count = connection.execute(
                "SELECT count(*) FROM agentbootup_fixture_canary "
                "WHERE profile=?", (f"probe-uncommitted-{profile}",)
            ).fetchone()[0]
            pair_count = connection.execute(
                "SELECT count(*) FROM agentbootup_fixture_canary "
                "WHERE profile IN (?,?)",
                (f"probe-pair-a-{profile}", f"probe-pair-b-{profile}"),
            ).fetchone()[0]
            schema_version = connection.execute(
                "SELECT version FROM schema_version LIMIT 1"
            ).fetchone()[0]
        else:
            native_count = connection.execute(
                "SELECT count(*) FROM executions "
                "WHERE source='synthetic' AND status='completed' "
                "AND id NOT LIKE 'probe-%'"
            ).fetchone()[0]
            fixture_count = native_count
            committed_count = connection.execute(
                "SELECT count(*) FROM executions WHERE id=?",
                (f"probe-committed-{profile}",),
            ).fetchone()[0]
            uncommitted_count = connection.execute(
                "SELECT count(*) FROM executions WHERE id=?",
                (f"probe-uncommitted-{profile}",),
            ).fetchone()[0]
            pair_count = connection.execute(
                "SELECT count(*) FROM executions WHERE id IN (?,?)",
                (f"probe-pair-a-{profile}", f"probe-pair-b-{profile}"),
            ).fetchone()[0]
            schema_version = None
    sidecars_absent = not path.with_name(path.name + "-wal").exists() and \
        not path.with_name(path.name + "-shm").exists()
    return {
        "quickCheckPreflight": quick == ["ok"],
        "integrityCheckFull": integrity == ["ok"],
        "foreignKeyCheck": len(foreign_keys) == 0,
        "expectedTables": expected["tables"] <= tables,
        "expectedColumns": columns_ok,
        "expectedIndexes": expected["indexes"] <= indexes,
        "expectedTriggers": trigger_count == (6 if db_class == "session_database" else 0),
        "exactSchemaFingerprint": schema_sha256 == expected["schemaSha256"],
        "exactSchemaObjectCount": len(schema_rows) == expected["objectCount"],
        "schemaVersion22": schema_version == 22 if schema_version is not None else None,
        "nativeCanaryPresent": native_count == 1,
        "fixtureCanaryPresent": fixture_count == 1,
        "committedCanaryPresent": committed_count == 1,
        "uncommittedCanaryAbsent": uncommitted_count == 0,
        "atomicPairComplete": pair_count == 2,
        "standaloneNoSidecars": sidecars_absent,
    }


def snapshot_member(profile: str, db_class: str) -> str:
    prefix = "" if profile == "default" else f"profiles/{profile}/"
    relative = "state.db" if db_class == "session_database" else "cron/executions.db"
    return prefix + relative


def validate_snapshot(path: Path, profile: str, db_class: str) -> dict[str, object]:
    evidence = schema_evidence(path, profile, db_class)
    required = (
        evidence["quickCheckPreflight"],
        evidence["integrityCheckFull"],
        evidence["foreignKeyCheck"],
        evidence["expectedTables"],
        evidence["expectedColumns"],
        evidence["expectedIndexes"],
        evidence["expectedTriggers"],
        evidence["exactSchemaFingerprint"],
        evidence["exactSchemaObjectCount"],
        evidence["nativeCanaryPresent"],
        evidence["fixtureCanaryPresent"],
        evidence["committedCanaryPresent"],
        evidence["uncommittedCanaryAbsent"],
        evidence["atomicPairComplete"],
        evidence["standaloneNoSidecars"],
    )
    if db_class == "session_database":
        required += (evidence["schemaVersion22"],)
    if not all(required):
        refuse("engine-safe database snapshot failed qualification")
    return evidence


def profile_archive_disposition(archive: Path, profile: str) -> dict[str, object]:
    with tarfile.open(archive, "r:gz") as handle:
        names = {
            PurePosixPath(member.name).as_posix()
            for member in handle.getmembers() if member.isfile()
        }
    prefix = f"{profile}/"
    state = prefix + "state.db"
    execution = prefix + "cron/executions.db"
    db_members = sum(name in names for name in (state, execution))
    sidecars = sum(
        name in names
        for base in (state, execution)
        for name in (base + "-wal", base + "-shm")
    )
    return {
        "rawDatabaseMembers": db_members,
        "rawSidecarMembers": sidecars,
        "disposition": "discard_unqualified",
    }


def backup_failure_evidence(backup, source: Path, destination: Path) -> dict[str, bool]:
    original_connect = backup.sqlite3.connect
    calls = 0

    class FailingSource:
        def backup(self, _destination) -> None:
            raise sqlite3.OperationalError("injected backup failure")

        def close(self) -> None:
            return None

    def injected_connect(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            return FailingSource()
        return original_connect(*args, **kwargs)

    backup.sqlite3.connect = injected_connect
    try:
        returned, _ = call_quietly(backup._safe_copy_db, source, destination)
    finally:
        backup.sqlite3.connect = original_connect
    with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as connection:
        source_integrity = [
            row[0] for row in connection.execute("PRAGMA integrity_check")
        ] == ["ok"]
    return {
        "returnedFalse": returned is False,
        "destinationDeleted": not destination.exists(),
        "sourceStillValid": source_integrity
        and fixture_canaries_present(source, "default", "session_database"),
    }


def bounded_cleanup(root: Path, identity: tuple[int, int, int]) -> None:
    current = root.lstat()
    if (current.st_dev, current.st_ino, current.st_uid) != identity:
        refuse("cleanup target identity changed")
    if root.parent == root or not root.name.startswith("task-1-11-"):
        refuse("cleanup target is not a bounded probe directory")
    shutil.rmtree(root)


def run_probe(request: dict[str, object]) -> dict[str, object]:
    allowed = {
        "installRoot", "sourceHome", "workRoot", "hermesWheel",
        "outputPath", "executionClass",
    }
    if not isinstance(request, dict) or set(request) != allowed:
        refuse("request schema mismatch")
    install_root = HELPERS.canonical_directory(request["installRoot"], "install root")
    source_home = HELPERS.canonical_directory(request["sourceHome"], "source home")
    work_root = HELPERS.canonical_directory(request["workRoot"], "work root", empty=True)
    wheel = HELPERS.canonical_file(request["hermesWheel"], "Hermes wheel")
    output = Path(str(request["outputPath"]))
    if not output.is_absolute() or str(output) != os.path.normpath(str(output)):
        refuse("output path must be normalized and absolute")
    if output.parent != work_root or output.exists():
        refuse("output must be a new direct child of the work root")
    if request["executionClass"] not in {
        "local_discovery_nonclosing", "github_actions_exact_lane",
    }:
        refuse("execution class is invalid")
    live_home = Path.home().resolve()
    for root in (source_home, work_root):
        if HELPERS.contained(live_home, root) or HELPERS.contained(root, live_home):
            refuse("probe root overlaps the live user home")
    source_before = HELPERS.metadata_fingerprint(source_home)
    source_hashes = verify_runtime(install_root, wheel)

    probe_root = work_root / "task-1-11-disposable"
    probe_root.mkdir(mode=PRIVATE_DIR_MODE)
    identity_info = probe_root.lstat()
    identity = (identity_info.st_dev, identity_info.st_ino, identity_info.st_uid)
    scenario = probe_root / "scenario"
    user_home = probe_root / "user"
    artifacts = probe_root / "artifacts"
    snapshots = probe_root / "snapshots"
    try:
        for directory in (user_home, artifacts, snapshots):
            directory.mkdir(mode=PRIVATE_DIR_MODE)
        shutil.copytree(source_home, scenario)
        HELPERS.validate_private_tree(scenario, "disposable scenario")
        native_environment(user_home, scenario, artifacts)
        sys.path.insert(0, str(wheel))
        backup = importlib.import_module("hermes_cli.backup")
        profiles = importlib.import_module("hermes_cli.profiles")
        for module in (backup, profiles):
            if not str(module.__file__).startswith(f"{wheel}/"):
                refuse("native Hermes module did not load from verified wheel")
        if scenario_sidecars(scenario):
            refuse("Task 1.6 fixture unexpectedly retained SQLite sidecars")
    except Exception:
        bounded_cleanup(probe_root, identity)
        raise

    writers: dict[tuple[str, str], sqlite3.Connection] = {}
    try:
        for profile in PROFILE_NAMES:
            for db_class in DB_CLASSES:
                path = database_path(scenario, profile, db_class)
                if not fixture_canaries_present(path, profile, db_class):
                    refuse("Task 1.6 native database fixture drifted")
                writers[(profile, db_class)] = open_wal_canary(
                    path, profile, db_class
                )
        created_sidecars = scenario_sidecars(scenario)
        if len(created_sidecars) != 12 or any(
            path.name.endswith("-journal") for path in created_sidecars
        ):
            refuse("open WAL writers did not create the expected sidecar set")

        raw_misses = 0
        safe_rows = []
        for profile in PROFILE_NAMES:
            row = {"profile": profile, "databases": {}}
            for db_class in DB_CLASSES:
                source = database_path(scenario, profile, db_class)
                raw = artifacts / f"raw-{profile}-{db_class}.db"
                shutil.copy2(source, raw)
                with sqlite3.connect(f"file:{raw}?mode=ro&immutable=1", uri=True) as conn:
                    if db_class == "session_database":
                        count = conn.execute(
                            "SELECT count(*) FROM agentbootup_fixture_canary "
                            "WHERE profile=?", (f"probe-committed-{profile}",)
                        ).fetchone()[0]
                    else:
                        count = conn.execute(
                            "SELECT count(*) FROM executions WHERE id=?",
                            (f"probe-committed-{profile}",),
                        ).fetchone()[0]
                if count == 0:
                    raw_misses += 1
                raw.unlink()

                captured = snapshots / f"{profile}-{db_class}.db"
                success, _ = call_quietly(backup._safe_copy_db, source, captured)
                if success is not True:
                    refuse("native engine-safe snapshot failed")
                row["databases"][db_class] = validate_snapshot(
                    captured, profile, db_class
                )
                captured.unlink()
            safe_rows.append(row)

        full_archive = artifacts / "native-full.zip"
        returned, full_output = call_quietly(
            backup.run_backup, SimpleNamespace(output=str(full_archive))
        )
        if returned is not None or not full_archive.is_file():
            refuse("native full backup did not return normally")
        full_valid = 0
        with zipfile.ZipFile(full_archive) as archive:
            for profile in PROFILE_NAMES:
                for db_class in DB_CLASSES:
                    member = snapshot_member(profile, db_class)
                    extracted = snapshots / f"full-{profile}-{db_class}.db"
                    extracted.write_bytes(archive.read(member))
                    extracted.chmod(PRIVATE_FILE_MODE)
                    validate_snapshot(extracted, profile, db_class)
                    full_valid += 1
                    extracted.unlink()
        full_archive.unlink()

        export_rows = []
        for profile in PROFILE_NAMES:
            archive = artifacts / f"profile-{profile}.tar.gz"
            exported, _ = call_quietly(profiles.export_profile, profile, str(archive))
            export_rows.append({
                "profile": profile,
                **profile_archive_disposition(Path(exported), profile),
                "engineSafeSupplementsRequired": 2,
                "combinedCandidate": True,
            })
            Path(exported).unlink()

        failure_destination = artifacts / "failed-safe-copy.db"
        failure = backup_failure_evidence(
            backup,
            database_path(scenario, "default", "session_database"),
            failure_destination,
        )
        if not all(failure.values()):
            refuse("native _safe_copy_db failure semantics drifted")

        incomplete_archive = artifacts / "incomplete-full.zip"
        original_safe_copy = backup._safe_copy_db
        injected = False

        def fail_once(source: Path, destination: Path) -> bool:
            nonlocal injected
            if not injected and source.suffix == ".db":
                injected = True
                destination.unlink(missing_ok=True)
                return False
            return original_safe_copy(source, destination)

        backup._safe_copy_db = fail_once
        try:
            incomplete_returned, incomplete_output = call_quietly(
                backup.run_backup,
                SimpleNamespace(output=str(incomplete_archive)),
            )
        finally:
            backup._safe_copy_db = original_safe_copy
        incomplete = {
            "injected": injected,
            "returnedNormally": incomplete_returned is None,
            "archiveRetainedByNativeCommand": incomplete_archive.is_file(),
            "reportedIncomplete": "Backup incomplete:" in incomplete_output,
            "probeRetainedRawArchive": False,
        }
        if not all(value for key, value in incomplete.items() if key != "probeRetainedRawArchive"):
            refuse("native incomplete full-backup semantics drifted")
        incomplete_archive.unlink()
        if any(artifacts.iterdir()) or any(snapshots.iterdir()):
            refuse("raw database evidence was retained before bounded cleanup")
        if scenario_sidecars(scenario) != created_sidecars:
            refuse("scenario SQLite sidecar identities changed before cleanup")
    finally:
        for connection in writers.values():
            connection.close()
        if probe_root.exists():
            bounded_cleanup(probe_root, identity)
    if HELPERS.metadata_fingerprint(source_home) != source_before:
        refuse("source fixture changed during database probe")

    all_safe = all(
        all(
            all(
                value is True or key == "schemaVersion22"
                for key, value in database.items()
            )
            and (
                database["schemaVersion22"] is True
                if db_class == "session_database"
                else database["schemaVersion22"] is None
            )
            for db_class, database in row["databases"].items()
        )
        for row in safe_rows
    )
    oracle_evidence = {
        "HERMES-RO-DB-INTEGRITY-001": "six_engine_safe_snapshots_full_integrity",
        "HERMES-RO-DB-SCHEMA-001": "six_exact_schema_fingerprints",
        "HERMES-RO-DB-CANARY-001": "six_native_fixture_and_wal_canary_sets",
        "HERMES-RO-DB-WAL-001": "six_open_wal_writers_raw_copy_rejected",
        "HERMES-RO-DB-BACKUP-FAIL-CLOSED-001": "low_level_safe_copy_primitive_only",
        "HERMES-RO-DB-SOURCE-SIDECAR-DISPOSITION-001": "measured_disposable_sidecars_identity_bound_cleanup",
    }
    oracle_rows = [{
        "checkId": check_id,
        "status": "pass",
        "strategy": "profile_export_plus_engine_safe_supplements",
        "evidence": oracle_evidence[check_id],
    } for check_id in DB_ORACLES]
    result = {
        "schema": "agentbootup.hermes-m0h-database/v1",
        "qualification": "task_1_11_evidence_only",
        "executionClass": request["executionClass"],
        "hermes": {
            "package": HERMES_VERSION,
            "tag": HERMES_TAG,
            "commit": HERMES_COMMIT,
            "wheelSha256": HERMES_WHEEL_SHA256,
            "backupSourceSha256": source_hashes["backup"],
            "profilesSourceSha256": source_hashes["profiles"],
        },
        "scope": {
            "profiles": 3,
            "databaseClasses": 2,
            "openCommittedWalWriters": 6,
            "disposableCloneOnly": True,
            "liveHomeTouched": False,
            "scenarioSidecarsCreated": len(created_sidecars),
            "sourceSidecarsTouched": False,
            "scenarioSidecarDisposition": "deleted_with_bounded_disposable_clone",
        },
        "engineSafeSnapshots": {
            "count": 6,
            "allQualified": all_safe,
            "rows": safe_rows,
        },
        "nativeFullBackup": {
            "databaseMembersQualified": full_valid,
            "allSixEquivalentToEngineSafe": full_valid == 6,
        },
        "strategyComparison": {
            "rawMainOnly": {
                "databasesTested": 6,
                "committedWalCanariesMissed": raw_misses,
                "qualified": False,
                "disposition": "reject",
            },
            "rawProfileExport": {
                "profilesTested": 3,
                "rows": export_rows,
                "qualified": False,
                "disposition": "discard_unqualified",
            },
            "profileExportPlusEngineSafeSupplements": {
                "supplementsPerProfile": 2,
                "candidate": True,
                "qualification": "database_layer_only",
            },
            "nativeFullBackup": {
                "candidate": True,
                "qualification": "database_layer_only",
            },
        },
        "failureSemantics": {
            "safeCopy": failure,
            "fullBackup": incomplete,
        },
        "restoreOracleDraft": oracle_rows,
        "decision": "sqlite_api_capture_qualified_for_six_captured_databases",
        "cleanup": {
            "rawArchivesRetained": False,
            "snapshotsRetained": False,
            "temporaryHomesRetained": False,
            "boundedIdentityCleanup": True,
        },
        "blockers": [
            "task_1_10_installation_wide_cross_store_quiescence_still_required",
            "open_writer_per_database_success_does_not_prove_zero_writers_installation_wide",
            "profile_export_requires_two_engine_safe_database_supplements",
            "native_full_backup_retains_incomplete_archive_and_returns_normally",
        ],
    }
    encoded = json.dumps(result, sort_keys=True, separators=(",", ":"))
    forbidden = (
        str(install_root), str(source_home), str(work_root), str(wheel),
        "native-session-", "native-job-", "committed-open-writer",
        ".env", "auth.json", "-wal", "-shm",
    )
    if any(value in encoded for value in forbidden):
        refuse("structured result contains forbidden path, sidecar, or canary material")
    return result


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[0] != "--request":
        refuse("usage: hermes-m0h-database-probe.py --request /absolute/request.json")
    request_path = HELPERS.canonical_file(argv[1], "request", PRIVATE_FILE_MODE)
    request = json.loads(request_path.read_text(encoding="utf-8"))
    result = run_probe(request)
    encoded = json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(Path(str(request["outputPath"])), flags, PRIVATE_FILE_MODE)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(encoded)
    print(encoded, end="")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
