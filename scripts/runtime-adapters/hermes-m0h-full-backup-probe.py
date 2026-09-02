#!/usr/bin/env python3
"""Evidence-only Task 1.9 probe for Hermes full backup/import."""

from __future__ import annotations

import builtins
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
import stat
import sys
from types import SimpleNamespace
import zipfile

HERMES_VERSION = "0.19.0"
HERMES_COMMIT = "3ef6bbd201263d354fd83ec55b3c306ded2eb72a"
HERMES_WHEEL_SHA256 = "bd0bac012aee38a60894781f4597dc29ee7bedb3448540249921f10d3bef327f"
BACKUP_SOURCE_SHA256 = "1bcef6f736f1d52055837789f24becdba4a670f0a1abb5ac9973b1a1a7306f35"
PRIVATE_DIR_MODE = 0o700
PRIVATE_FILE_MODE = 0o600
PROFILE_NAMES = ("default", "atlas", "beacon")

EXISTING_ORACLE_IDS = (
    "HERMES-RO-PROFILE-ISOLATION-001",
    "HERMES-RO-CORE-CONFIG-001",
    "HERMES-RO-CORE-IDENTITY-001",
    "HERMES-RO-CORE-MEMORY-DOCS-001",
    "HERMES-RO-CORE-SKILLS-001",
    "HERMES-RO-CORE-HOOKS-001",
    "HERMES-RO-SESSION-FILES-001",
    "HERMES-RO-SESSION-DB-001",
    "HERMES-RO-CRON-DEFINITIONS-001",
    "HERMES-RO-CRON-EXECUTIONS-001",
    "HERMES-RO-SECRETS-EXCLUDED-001",
    "HERMES-RO-EXTERNAL-MEMORY-001",
    "HERMES-RO-MACHINE-LOCAL-001",
    "HERMES-RO-ALIAS-001",
    "HERMES-RO-TARGET-COLLISION-001",
    "HERMES-RO-DB-INTEGRITY-001",
    "HERMES-RO-DB-SCHEMA-001",
    "HERMES-RO-DB-CANARY-001",
    "HERMES-RO-DB-WAL-001",
)
NEW_ORACLE_IDS = (
    "HERMES-RO-CAPTURE-COMPLETE-001",
    "HERMES-RO-CAPTURE-FAILURE-ATOMIC-001",
    "HERMES-RO-RESTORE-ATOMIC-001",
    "HERMES-RO-RESTORE-OVERLAY-001",
    "HERMES-RO-EXTERNAL-DESTINATION-001",
    "HERMES-RO-RAW-ARCHIVE-CLEANUP-001",
)


def refuse(message: str) -> None:
    raise RuntimeError(f"Hermes full-backup probe refused: {message}")


def helpers_module():
    path = Path(__file__).with_name("hermes-m0h-profile-transfer-probe.py")
    spec = importlib.util.spec_from_file_location("hermes_profile_transfer_helpers", path)
    if spec is None or spec.loader is None:
        refuse("cannot load profile-transfer validation helpers")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HELPERS = helpers_module()


def write_private(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=PRIVATE_DIR_MODE)
    path.write_text(value, encoding="utf-8")
    path.chmod(PRIVATE_FILE_MODE)


def profile_root(home: Path, name: str) -> Path:
    return home if name == "default" else home / "profiles" / name


def inject_scenario(source_home: Path, scenario_home: Path, source_user_home: Path) -> dict[str, Path]:
    shutil.copytree(source_home, scenario_home)
    for name in PROFILE_NAMES:
        root = profile_root(scenario_home, name)
        if not (root / "state.db").is_file() or not (root / "cron" / "executions.db").is_file():
            refuse("Task 1.6 database fixture drifted")
        for relative in (
            "pairing/approved.json",
            "hooks/synthetic.py",
            "gateway.pid",
            "gateway_state.json",
            "gateway.lock",
            "processes.json",
            "logs/gateway.log",
            "image_cache/item.bin",
            "audio_cache/item.bin",
            ".cache/ignored.bin",
        ):
            write_private(root / relative, f"SYNTHETIC_TASK_1_9::{name}::{relative}\n")
    write_private(scenario_home / "active_profile", "atlas\n")
    (scenario_home / "synthetic-link").symlink_to("config.yaml")

    active_external = source_user_home / ".honcho" / "config.json"
    sibling_external_a = source_user_home / ".atlas-memory" / "state.json"
    sibling_external_b = source_user_home / ".beacon-memory" / "state.json"
    outside_external = scenario_home.parent / "outside-provider" / "state.json"
    for path, label in (
        (active_external, "active"),
        (sibling_external_a, "atlas"),
        (sibling_external_b, "beacon"),
        (outside_external, "outside"),
    ):
        write_private(path, f"SYNTHETIC_TASK_1_9_EXTERNAL::{label}\n")
    return {
        "active": active_external,
        "atlas": sibling_external_a,
        "beacon": sibling_external_b,
        "outside": outside_external,
    }


def owner_and_relative(member: str) -> tuple[str, str]:
    parts = PurePosixPath(member).parts
    if len(parts) >= 3 and parts[0] == "profiles" and parts[1] in {"atlas", "beacon"}:
        return parts[1], PurePosixPath(*parts[2:]).as_posix()
    return "default", PurePosixPath(*parts).as_posix()


def classify_member(member: str) -> tuple[str, str]:
    if member.startswith("_external/"):
        return "external", "external_memory"
    owner, relative = owner_and_relative(member)
    first = relative.split("/", 1)[0]
    if relative in {".env", "auth.json"} or first == "pairing":
        return owner, "authorization"
    if relative == "config.yaml":
        return owner, "config"
    if relative == "SOUL.md":
        return owner, "identity"
    if first == "memories":
        return owner, "memory"
    if first == "skills":
        return owner, "skills"
    if first == "sessions":
        return owner, "sessions"
    if relative == "state.db":
        return owner, "session_database"
    if relative == "cron/jobs.json":
        return owner, "cron_definitions"
    if relative == "cron/executions.db":
        return owner, "cron_executions"
    if relative == "cron/.jobs.lock" or relative == "active_profile":
        return owner, "machine_local"
    if first == "hooks":
        return owner, "hooks"
    if relative in {"gateway_state.json", "gateway.lock", "processes.json"}:
        return owner, "machine_local"
    if first in {"logs", "image_cache", "audio_cache"}:
        return owner, "cache_log"
    if relative == "external-state.json":
        return owner, "external_declaration"
    refuse("full archive contains an unclassified member")


def archive_accounting(archive: Path) -> tuple[dict[str, dict[str, int]], set[str]]:
    counts: dict[str, dict[str, int]] = {
        owner: {} for owner in (*PROFILE_NAMES, "external")
    }
    names: set[str] = set()
    with zipfile.ZipFile(archive) as handle:
        for info in handle.infolist():
            if info.is_dir():
                continue
            if info.filename in names:
                refuse("full archive contains duplicate members")
            names.add(info.filename)
            owner, item_class = classify_member(info.filename)
            owner_counts = counts[owner]
            owner_counts[item_class] = owner_counts.get(item_class, 0) + 1
    return counts, names


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
    output = io.StringIO()
    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
        result = function(*args)
    return result, output.getvalue()


def exercise_incomplete_backup(backup, output: Path) -> tuple[object, str, bool]:
    """Inject one database-copy failure through the production native-backup seam."""
    original_safe_copy = backup._safe_copy_db
    failed_once = False

    def fail_one_db(src: Path, dst: Path) -> bool:
        nonlocal failed_once
        if not failed_once:
            failed_once = True
            return False
        return original_safe_copy(src, dst)

    backup._safe_copy_db = fail_one_db
    try:
        result, captured = call_quietly(
            backup.run_backup, SimpleNamespace(output=str(output))
        )
    finally:
        backup._safe_copy_db = original_safe_copy
    return result, captured, failed_once


def audit_hook(event: str, _args: tuple[object, ...]) -> None:
    if event in {"socket.connect", "socket.bind", "socket.getaddrinfo"}:
        refuse(f"forbidden audited operation: {event}")


def bound_identity(path: Path) -> tuple[int, int, int]:
    info = path.lstat()
    return info.st_dev, info.st_ino, info.st_uid


def file_metadata(root: Path) -> dict[str, tuple[int, int, int, int, int]]:
    result = {}
    for candidate in root.rglob("*"):
        info = candidate.lstat()
        if stat.S_ISREG(info.st_mode):
            result[candidate.relative_to(root).as_posix()] = (
                info.st_size,
                info.st_mtime_ns,
                info.st_dev,
                info.st_ino,
                info.st_nlink,
            )
    return result


def delete_bound(path: Path, identity: tuple[int, int, int]) -> None:
    info = path.lstat()
    if (info.st_dev, info.st_ino, info.st_uid) != identity or not stat.S_ISREG(info.st_mode):
        refuse("raw archive identity changed before cleanup")
    path.unlink()


def comparison_oracle() -> list[dict[str, str]]:
    outcomes = {
        "HERMES-RO-PROFILE-ISOLATION-001": ("fail", "full_archive_contains_siblings"),
        "HERMES-RO-CORE-CONFIG-001": ("pass", "full_overlay_restores_payload"),
        "HERMES-RO-CORE-IDENTITY-001": ("pass", "full_overlay_restores_payload"),
        "HERMES-RO-CORE-MEMORY-DOCS-001": ("pass", "full_overlay_restores_payload"),
        "HERMES-RO-CORE-SKILLS-001": ("pass", "full_overlay_restores_payload"),
        "HERMES-RO-CORE-HOOKS-001": ("pass", "full_overlay_restores_payload"),
        "HERMES-RO-SESSION-FILES-001": ("pass", "full_overlay_restores_payload"),
        "HERMES-RO-SESSION-DB-001": ("pass", "membership_only_database_safety_separate"),
        "HERMES-RO-CRON-DEFINITIONS-001": ("pass", "full_overlay_restores_payload"),
        "HERMES-RO-CRON-EXECUTIONS-001": ("pass", "membership_only_database_safety_separate"),
        "HERMES-RO-SECRETS-EXCLUDED-001": ("fail", "full_archive_contains_all_profile_secrets"),
        "HERMES-RO-EXTERNAL-MEMORY-001": ("fail", "only_active_provider_state_enumerated"),
        "HERMES-RO-MACHINE-LOCAL-001": ("fail", "active_profile_and_cron_locks_overwrite_target"),
        "HERMES-RO-ALIAS-001": ("fail", "custom_source_aliases_not_preserved"),
        "HERMES-RO-TARGET-COLLISION-001": ("fail", "force_import_overlays_existing_target"),
        "HERMES-RO-DB-INTEGRITY-001": ("blocked", "requires_task_1_11"),
        "HERMES-RO-DB-SCHEMA-001": ("blocked", "requires_task_1_11"),
        "HERMES-RO-DB-CANARY-001": ("blocked", "requires_task_1_11"),
        "HERMES-RO-DB-WAL-001": ("blocked", "requires_task_1_11"),
    }
    rows = []
    for check_id in EXISTING_ORACLE_IDS:
        status, reason = outcomes[check_id]
        row = {"checkId": check_id, "status": status, "reason": reason}
        if status == "blocked":
            row["dependency"] = "task_1_11"
        rows.append(row)
    return rows


def oracle_extensions() -> list[dict[str, str]]:
    reasons = {
        "HERMES-RO-CAPTURE-COMPLETE-001": "sqlite_failure_returns_normally_with_missing_database",
        "HERMES-RO-CAPTURE-FAILURE-ATOMIC-001": "incomplete_raw_archive_is_retained",
        "HERMES-RO-RESTORE-ATOMIC-001": "member_failure_returns_normally_after_partial_write",
        "HERMES-RO-RESTORE-OVERLAY-001": "target_only_state_survives_force_import",
        "HERMES-RO-EXTERNAL-DESTINATION-001": "archive_path_not_provider_identity_controls_destination",
        "HERMES-RO-RAW-ARCHIVE-CLEANUP-001": "bounded_probe_identity_deletes_all_raw_archives",
    }
    return [
        {
            "checkId": check_id,
            "status": "pass" if check_id == "HERMES-RO-RAW-ARCHIVE-CLEANUP-001" else "fail",
            "reason": reasons[check_id],
        }
        for check_id in NEW_ORACLE_IDS
    ]


def run_probe(request: dict[str, object]) -> dict[str, object]:
    allowed = {"sourceHome", "workRoot", "hermesWheel", "outputPath", "executionClass"}
    if not isinstance(request, dict) or set(request) != allowed:
        refuse("request schema mismatch")
    source_home = HELPERS.canonical_directory(request["sourceHome"], "source home")
    work_root = HELPERS.canonical_directory(request["workRoot"], "work root", empty=True)
    wheel = HELPERS.canonical_file(request["hermesWheel"], "Hermes wheel")
    output = Path(str(request["outputPath"]))
    if output.parent != work_root or output.exists():
        refuse("output must be a new direct child of the private work root")
    execution_class = request["executionClass"]
    if execution_class not in {"local_discovery_nonclosing", "github_actions_exact_lane"}:
        refuse("execution class is invalid")
    live_home = Path.home().resolve()
    if HELPERS.contained(live_home, source_home) or HELPERS.contained(source_home, live_home):
        refuse("source home overlaps the live user home")
    if HELPERS.contained(live_home, work_root) or HELPERS.contained(work_root, live_home):
        refuse("work root overlaps the live user home")
    if HELPERS.sha256_file(wheel) != HERMES_WHEEL_SHA256:
        refuse("Hermes wheel digest drifted")
    with zipfile.ZipFile(wheel) as handle:
        if HELPERS.sha256_bytes(handle.read("hermes_cli/backup.py")) != BACKUP_SOURCE_SHA256:
            refuse("Hermes backup.py digest drifted")

    os.umask(0o077)
    HELPERS.validate_private_tree(source_home, "source home")
    source_before = HELPERS.metadata_fingerprint(source_home)
    scenario_home = work_root / "source-hermes"
    source_user_home = work_root / "source-user"
    target_home = work_root / "target-user"
    target_root = work_root / "target-hermes"
    archive_root = work_root / "archives"
    temp_root = work_root / "temp"
    for directory in (source_user_home, target_home, target_root, archive_root, temp_root):
        directory.mkdir(mode=PRIVATE_DIR_MODE)
    external = inject_scenario(source_home, scenario_home, source_user_home)
    scenario_files_before = file_metadata(scenario_home)

    native_environment(source_user_home, scenario_home, temp_root)
    sys.addaudithook(audit_hook)
    sys.path.insert(0, str(wheel))
    backup = importlib.import_module("hermes_cli.backup")
    profiles = importlib.import_module("hermes_cli.profiles")
    if not str(backup.__file__).startswith(f"{wheel}/") or \
            importlib.metadata.version("hermes-agent") != HERMES_VERSION:
        refuse("Hermes backup module did not load from the verified wheel")
    original_collector = backup._collect_memory_provider_external_paths
    backup._collect_memory_provider_external_paths = lambda: [
        external["active"], external["outside"]
    ]

    for alias, target in (("navigator", "atlas"), ("watchtower", "beacon")):
        created = profiles.create_wrapper_script(alias, target=target)
        if created is None:
            refuse("source custom alias creation failed")

    success_archive = archive_root / "full-success.zip"
    incomplete_archive = archive_root / "full-incomplete.zip"
    traversal_archive = archive_root / "import-traversal.zip"
    write_fault_archive = archive_root / "import-write-fault.zip"
    invalid_archive = archive_root / "invalid.bin"
    invalid_marker_archive = archive_root / "invalid-marker.zip"
    raw_identities: dict[Path, tuple[int, int, int]] = {}

    safe_copy_calls = 0
    original_safe_copy = backup._safe_copy_db

    def counted_safe_copy(src: Path, dst: Path) -> bool:
        nonlocal safe_copy_calls
        safe_copy_calls += 1
        return original_safe_copy(src, dst)

    backup._safe_copy_db = counted_safe_copy
    try:
        _, success_output = call_quietly(
            backup.run_backup, SimpleNamespace(output=str(success_archive))
        )
    finally:
        backup._safe_copy_db = original_safe_copy
    if "Backup complete:" not in success_output or not success_archive.is_file():
        refuse("native full backup did not complete")
    raw_identities[success_archive] = bound_identity(success_archive)
    archive_counts, archive_names = archive_accounting(success_archive)
    if safe_copy_calls != 6:
        refuse("native full backup database snapshot count drifted")
    for name in PROFILE_NAMES:
        counts = archive_counts[name]
        if counts.get("authorization") != 3 or counts.get("session_database") != 1 or \
                counts.get("cron_executions") != 1:
            refuse("native full backup profile membership drifted")
    if archive_counts["external"].get("external_memory") != 1:
        refuse("native full backup external membership drifted")
    if any(name.endswith((".db-wal", ".db-shm", ".db-journal")) for name in archive_names):
        refuse("native full backup retained a database sidecar")
    if any(PurePosixPath(name).name in {"gateway.pid", "cron.pid"} for name in archive_names):
        refuse("native full backup retained a PID file")
    if "synthetic-link" in archive_names:
        refuse("native full backup followed or retained a source symlink")

    # Prove incomplete-backup exit semantics with one deterministic DB failure.
    failure_result, failure_output, failed_once = exercise_incomplete_backup(
        backup, incomplete_archive
    )
    if not failed_once or failure_result is not None or \
            "Backup incomplete:" not in failure_output or \
            not incomplete_archive.is_file():
        refuse("native incomplete-backup semantics drifted")
    raw_identities[incomplete_archive] = bound_identity(incomplete_archive)
    incomplete_counts, _ = archive_accounting(incomplete_archive)
    incomplete_db_count = sum(
        row.get("session_database", 0) + row.get("cron_executions", 0)
        for owner, row in incomplete_counts.items()
        if owner in PROFILE_NAMES
    )
    if incomplete_db_count != 5:
        refuse("faulted backup did not omit exactly one database")

    # Prepopulate an overlay target and prove native import dispositions.
    write_private(target_root / "config.yaml", "TARGET_CONFIG\n")
    write_private(target_root / "target-only.txt", "TARGET_ONLY\n")
    write_private(target_root / "active_profile", "beacon\n")
    for name in PROFILE_NAMES:
        root = profile_root(target_root, name)
        for relative in ("gateway_state.json", "gateway.lock", "processes.json"):
            write_private(root / relative, f"TARGET_MACHINE::{name}::{relative}\n")
        write_private(root / "cron" / ".jobs.lock", f"TARGET_CRON_LOCK::{name}\n")
    target_external = target_home / ".honcho" / "config.json"
    write_private(target_external, "TARGET_EXTERNAL\n")
    target_machine_before = {
        f"{name}:{relative}": (profile_root(target_root, name) / relative).read_bytes()
        for name in PROFILE_NAMES
        for relative in ("gateway_state.json", "gateway.lock", "processes.json")
    }
    target_locks_before = {
        name: (profile_root(target_root, name) / "cron" / ".jobs.lock").read_bytes()
        for name in PROFILE_NAMES
    }

    native_environment(target_home, target_root, temp_root)
    previous_umask = os.umask(0o022)
    try:
        _, import_output = call_quietly(
            backup.run_import, SimpleNamespace(zipfile=str(success_archive), force=True)
        )
    finally:
        os.umask(previous_umask)
    if "Import complete:" not in import_output:
        refuse("native full import did not complete")
    if (target_root / "config.yaml").read_bytes() != (scenario_home / "config.yaml").read_bytes():
        refuse("native overlay did not overwrite normal state")
    if not (target_root / "target-only.txt").is_file():
        refuse("native overlay removed target-only state unexpectedly")
    if (target_root / "active_profile").read_bytes() == b"beacon\n":
        refuse("native overlay did not overwrite active profile")
    for key, value in target_machine_before.items():
        name, relative = key.split(":", 1)
        if (profile_root(target_root, name) / relative).read_bytes() != value:
            refuse("native import overwrote protected gateway/process state")
    for name, value in target_locks_before.items():
        if (profile_root(target_root, name) / "cron" / ".jobs.lock").read_bytes() == value:
            refuse("native import unexpectedly preserved a cron lock")
    if target_external.read_bytes() != external["active"].read_bytes():
        refuse("native import external destination drifted")
    for name in ("atlas", "beacon"):
        if not profile_root(target_root, name).is_dir():
            refuse("native import omitted a sibling profile")
        if profiles.find_alias_for_profile(name) != name:
            refuse("native import did not create the generic target alias")
    pairing_modes = [
        stat.S_IMODE((profile_root(target_root, name) / "pairing" / "approved.json").stat().st_mode)
        for name in PROFILE_NAMES
    ]
    pairing_owner_only = all(mode == PRIVATE_FILE_MODE for mode in pairing_modes)
    if pairing_owner_only:
        refuse("pairing permission probe unexpectedly passed")
    for name in PROFILE_NAMES:
        for relative in (".env", "auth.json", "state.db"):
            if stat.S_IMODE((profile_root(target_root, name) / relative).stat().st_mode) != PRIVATE_FILE_MODE:
                refuse("native import did not tighten a known secret file")
    if stat.S_IMODE(target_external.stat().st_mode) != PRIVATE_FILE_MODE:
        refuse("native import did not tighten external JSON")

    # Account for every success-archive member after import.
    skipped_runtime = {"gateway_state.json", "gateway.pid", "cron.pid", "gateway.lock", "processes.json"}
    restored = skipped = external_restored = 0
    for member in archive_names:
        if member.startswith("_external/"):
            external_restored += 1
            continue
        if PurePosixPath(member).name in skipped_runtime:
            skipped += 1
            continue
        if not target_root.joinpath(*PurePosixPath(member).parts).is_file():
            refuse("native import left an archive member unaccounted")
        restored += 1
    if restored + skipped + external_restored != len(archive_names):
        refuse("native import disposition accounting drifted")

    # Traversal is blocked after a safe member was already overlaid; API returns normally.
    with zipfile.ZipFile(traversal_archive, "w") as handle:
        handle.writestr("config.yaml", "PARTIAL_CONFIG\n")
        handle.writestr("../escape", "BLOCKED\n")
    raw_identities[traversal_archive] = bound_identity(traversal_archive)
    traversal_home = work_root / "traversal-user"
    traversal_root = work_root / "traversal-target"
    traversal_home.mkdir(mode=PRIVATE_DIR_MODE)
    traversal_root.mkdir(mode=PRIVATE_DIR_MODE)
    native_environment(traversal_home, traversal_root, temp_root)
    traversal_result, traversal_output = call_quietly(
        backup.run_import, SimpleNamespace(zipfile=str(traversal_archive), force=True)
    )
    if traversal_result is not None or "Warnings (1 files skipped)" not in traversal_output or \
            not (traversal_root / "config.yaml").is_file() or \
            (work_root / "escape").exists():
        refuse("native traversal failure semantics drifted")

    # A target write failure is also partial and returns normally.
    with zipfile.ZipFile(write_fault_archive, "w") as handle:
        handle.writestr("config.yaml", "PARTIAL_CONFIG\n")
        handle.writestr("SOUL.md", "WRITE_FAULT\n")
    raw_identities[write_fault_archive] = bound_identity(write_fault_archive)
    fault_home = work_root / "write-fault-user"
    fault_root = work_root / "write-fault-target"
    fault_home.mkdir(mode=PRIVATE_DIR_MODE)
    fault_root.mkdir(mode=PRIVATE_DIR_MODE)
    native_environment(fault_home, fault_root, temp_root)
    real_open = builtins.open

    def fail_target_write(file, mode="r", *args, **kwargs):
        if Path(file) == fault_root / "SOUL.md" and "w" in mode:
            raise PermissionError("synthetic write fault")
        return real_open(file, mode, *args, **kwargs)

    builtins.open = fail_target_write
    try:
        write_result, write_output = call_quietly(
            backup.run_import, SimpleNamespace(zipfile=str(write_fault_archive), force=True)
        )
    finally:
        builtins.open = real_open
    if write_result is not None or "Warnings (1 files skipped)" not in write_output or \
            not (fault_root / "config.yaml").is_file() or (fault_root / "SOUL.md").exists():
        refuse("native write-failure semantics drifted")

    # Invalid archive exits one and leaves its target empty.
    invalid_archive.write_bytes(b"not a zip")
    invalid_archive.chmod(PRIVATE_FILE_MODE)
    raw_identities[invalid_archive] = bound_identity(invalid_archive)
    invalid_home = work_root / "invalid-user"
    invalid_root = work_root / "invalid-target"
    invalid_home.mkdir(mode=PRIVATE_DIR_MODE)
    invalid_root.mkdir(mode=PRIVATE_DIR_MODE)
    native_environment(invalid_home, invalid_root, temp_root)
    invalid_exit = None
    try:
        call_quietly(backup.run_import, SimpleNamespace(zipfile=str(invalid_archive), force=True))
    except SystemExit as exc:
        invalid_exit = exc.code
    if invalid_exit != 1 or any(invalid_root.iterdir()):
        refuse("native invalid-archive failure semantics drifted")

    # A structurally valid zip without a Hermes marker also exits one before mutation.
    with zipfile.ZipFile(invalid_marker_archive, "w") as handle:
        handle.writestr("README.txt", "NOT_A_HERMES_BACKUP\n")
    raw_identities[invalid_marker_archive] = bound_identity(invalid_marker_archive)
    marker_home = work_root / "marker-user"
    marker_root = work_root / "marker-target"
    marker_home.mkdir(mode=PRIVATE_DIR_MODE)
    marker_root.mkdir(mode=PRIVATE_DIR_MODE)
    native_environment(marker_home, marker_root, temp_root)
    invalid_marker_exit = None
    try:
        call_quietly(
            backup.run_import,
            SimpleNamespace(zipfile=str(invalid_marker_archive), force=True),
        )
    except SystemExit as exc:
        invalid_marker_exit = exc.code
    if invalid_marker_exit != 1 or any(marker_root.iterdir()):
        refuse("native invalid-marker failure semantics drifted")

    # A non-force rejection returns zero/None and leaves the existing target stable.
    reject_home = work_root / "reject-user"
    reject_root = work_root / "reject-target"
    reject_home.mkdir(mode=PRIVATE_DIR_MODE)
    reject_root.mkdir(mode=PRIVATE_DIR_MODE)
    write_private(reject_root / "config.yaml", "REJECT_TARGET\n")
    reject_before = HELPERS.metadata_fingerprint(reject_root)
    native_environment(reject_home, reject_root, temp_root)
    real_input = builtins.input
    builtins.input = lambda _prompt="": "n"
    try:
        reject_result, _ = call_quietly(
            backup.run_import, SimpleNamespace(zipfile=str(success_archive), force=False)
        )
    finally:
        builtins.input = real_input
    if reject_result is not None or HELPERS.metadata_fingerprint(reject_root) != reject_before:
        refuse("native non-force rejection semantics drifted")

    backup._collect_memory_provider_external_paths = original_collector
    source_stable = HELPERS.metadata_fingerprint(source_home) == source_before
    if not source_stable:
        refuse("Task 1.6 source home changed during full-backup probe")
    scenario_files_after_native = file_metadata(scenario_home)
    created_source_files = set(scenario_files_after_native) - set(scenario_files_before)
    removed_source_files = set(scenario_files_before) - set(scenario_files_after_native)
    changed_source_files = {
        name
        for name in set(scenario_files_before) & set(scenario_files_after_native)
        if scenario_files_before[name] != scenario_files_after_native[name]
    }
    if removed_source_files or changed_source_files or not created_source_files or any(
        not name.endswith((".db-wal", ".db-shm")) for name in created_source_files
    ):
        refuse("native full backup source mutation exceeded SQLite sidecar creation")
    created_sidecar_identities = {
        scenario_home / name: bound_identity(scenario_home / name)
        for name in created_source_files
    }

    native_left_success_archive = success_archive.is_file()
    native_left_incomplete_archive = incomplete_archive.is_file()
    for path, identity in raw_identities.items():
        delete_bound(path, identity)
    for path, identity in created_sidecar_identities.items():
        delete_bound(path, identity)
    if any(archive_root.iterdir()) or any(temp_root.iterdir()):
        refuse("raw archive or SQLite temporary artifact survived bounded cleanup")
    scenario_stable_after_cleanup = file_metadata(scenario_home) == scenario_files_before
    if not scenario_stable_after_cleanup:
        refuse("bounded cleanup did not restore the source scenario file set")

    archive_summary = [
        {
            "owner": owner,
            "classes": [
                {"logicalClass": item_class, "memberCount": count}
                for item_class, count in sorted(classes.items())
            ],
            "memberCount": sum(classes.values()),
        }
        for owner, classes in archive_counts.items()
    ]
    result = {
        "schema": "agentbootup.hermes-m0h-full-backup/v1",
        "qualification": "task_1_9_evidence_only",
        "executionClass": execution_class,
        "hermes": {
            "package": HERMES_VERSION,
            "tag": "v2026.7.20",
            "commit": HERMES_COMMIT,
            "wheelSha256": HERMES_WHEEL_SHA256,
            "backupSourceSha256": BACKUP_SOURCE_SHA256,
        },
        "trustBoundary": (
            "disposable_private_clone_exact_native_api_no_egress_namespace"
            if execution_class == "github_actions_exact_lane"
            else "disposable_private_clone_exact_native_api_socket_audit_guard"
        ),
        "archive": {
            "profileOwnerCount": 3,
            "containsSiblingProfiles": True,
            "containsAllProfileSecretDomains": True,
            "databaseSnapshotCount": safe_copy_calls,
            "databaseSidecarsAbsent": True,
            "pidFilesAbsent": True,
            "sourceLinksAbsent": True,
            "activeProviderExternalPayloadCount": 1,
            "siblingExternalPayloadCount": 0,
            "outsideHomeExternalPayloadCount": 0,
            "accountedMemberCount": len(archive_names),
            "ownership": archive_summary,
        },
        "restore": {
            "accountedMemberCount": restored + skipped + external_restored,
            "restoredMemberCount": restored,
            "skippedRuntimeMemberCount": skipped,
            "externalMemberCount": external_restored,
            "normalConflictsOverwritten": True,
            "targetOnlyStatePreserved": True,
            "gatewayProcessStatePreserved": True,
            "activeProfileOverwritten": True,
            "cronLocksOverwritten": True,
            "activeExternalDestinationOverwritten": True,
            "allSiblingProfilesRestored": True,
            "genericAliasesCreated": True,
            "customSourceAliasesPreserved": False,
            "pairingOwnerOnly": pairing_owner_only,
        },
        "failureSemantics": {
            "sqliteFailureReturnedNormally": failure_result is None,
            "sqliteFailureRetainedIncompleteArchive": native_left_incomplete_archive,
            "sqliteFailureMissingDatabaseCount": 1,
            "traversalFailureReturnedNormallyAfterPartialWrite": traversal_result is None,
            "writeFailureReturnedNormallyAfterPartialWrite": write_result is None,
            "invalidArchiveExitCode": invalid_exit,
            "invalidMarkerExitCode": invalid_marker_exit,
            "nonForceRejectionReturnedNormally": reject_result is None,
        },
        "cleanup": {
            "nativeRetainedSuccessArchiveAfterImport": native_left_success_archive,
            "boundedIdentityCleanupRemovedAllRawArtifacts": True,
        },
        "sourceHomeStable": source_stable,
        "sourceScenario": {
            "fileStateStableDuringNativeBackup": False,
            "sqliteSidecarFilesCreated": len(created_source_files),
            "fileStateStableAfterBoundedCleanup": scenario_stable_after_cleanup,
        },
        "restoreOracleComparison": comparison_oracle(),
        "restoreOracleExtensions": oracle_extensions(),
        "decision": "full_backup_is_installation_wide_transient_input_only",
        "blockers": [
            "multi_profile_and_secret_scope",
            "single_active_external_provider_scope",
            "capture_failure_returns_success_with_partial_archive",
            "restore_failure_returns_success_after_partial_overlay",
            "target_only_state_survives_overlay",
            "machine_local_active_profile_and_cron_lock_restored",
            "external_destination_not_provider_bound",
            "database_safety_pending_task_1_11",
        ],
    }
    encoded = json.dumps(result, sort_keys=True, separators=(",", ":"))
    forbidden = (
        str(source_home),
        str(work_root),
        "SYNTHETIC_TASK_1_9",
        ".env",
        "auth.json",
        "approved.json",
        "gateway.pid",
        ".honcho",
        "../escape",
    )
    if any(value in encoded for value in forbidden):
        refuse("structured result contains forbidden path or fixture material")
    return result


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[0] != "--request":
        refuse("usage: hermes-m0h-full-backup-probe.py --request /absolute/request.json")
    request_path = HELPERS.canonical_file(argv[1], "request", PRIVATE_FILE_MODE)
    request = json.loads(request_path.read_text(encoding="utf-8"))
    output = Path(str(request.get("outputPath", "")))
    result = run_probe(request)
    encoded = json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(output, flags, PRIVATE_FILE_MODE)
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
