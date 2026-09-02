#!/usr/bin/env python3
"""Evidence-only Task 1.8 probe for Hermes native profile export/import."""

from __future__ import annotations

import contextlib
import hashlib
import importlib
import importlib.metadata
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import sys
import tarfile
import zipfile

HERMES_VERSION = "0.19.0"
HERMES_COMMIT = "3ef6bbd201263d354fd83ec55b3c306ded2eb72a"
HERMES_WHEEL_SHA256 = "bd0bac012aee38a60894781f4597dc29ee7bedb3448540249921f10d3bef327f"
PROFILES_SOURCE_SHA256 = "dbfd34e5852e61ea501669d8b5db99e6a7e119b8ce4975e2211ea9546de1ac7b"
PRIVATE_DIR_MODE = 0o700
PRIVATE_FILE_MODE = 0o600
_ALLOW_ALIAS_COLLISION_PROBE = False

FIXTURE_FILES = {
    ".env": "authorization",
    "auth.json": "authorization",
    "pairing/telegram-approved.json": "authorization",
    "config.yaml": "config",
    "SOUL.md": "identity",
    "memories/MEMORY.md": "memory",
    "skills/synthetic-canary/SKILL.md": "skills",
    "sessions/session.json": "sessions",
    "state.db": "session_database",
    "state.db-wal": "session_database",
    "state.db-shm": "session_database",
    "cron/jobs.json": "cron_definitions",
    "cron/executions.db": "cron_executions",
    "cron/.jobs.lock": "cron_lock",
    "cron/output/run.log": "cron_output",
    "external-state.json": "external_declaration",
    "hooks/synthetic.py": "hooks",
    "gateway.pid": "machine_state",
    "gateway_state.json": "machine_state",
    "processes.json": "machine_state",
    "logs/gateway.log": "cache_log",
    "image_cache/item.bin": "cache_log",
}

CLASS_ORDER = (
    "authorization",
    "config",
    "identity",
    "memory",
    "skills",
    "sessions",
    "session_database",
    "cron_definitions",
    "cron_executions",
    "cron_lock",
    "cron_output",
    "external_declaration",
    "external_memory",
    "hooks",
    "machine_state",
    "cache_log",
    "alias",
)

ORACLE_IDS = (
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


def refuse(message: str) -> None:
    raise RuntimeError(f"Hermes profile-transfer probe refused: {message}")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def contained(parent: Path, child: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def canonical_directory(value: object, label: str, *, empty: bool = False) -> Path:
    if not isinstance(value, str):
        refuse(f"{label} must be a normalized absolute path")
    candidate = Path(value)
    if not candidate.is_absolute() or str(candidate) != os.path.normpath(value):
        refuse(f"{label} must be a normalized absolute path")
    info = candidate.lstat()
    if not stat.S_ISDIR(info.st_mode) or candidate.is_symlink():
        refuse(f"{label} must be a non-symlink directory")
    if stat.S_IMODE(info.st_mode) != PRIVATE_DIR_MODE:
        refuse(f"{label} must have mode 0700")
    if info.st_uid != os.getuid() or candidate.resolve() != candidate:
        refuse(f"{label} must be current-uid owned with no symlink ancestor")
    if empty and any(candidate.iterdir()):
        refuse(f"{label} must be empty")
    return candidate


def canonical_file(value: object, label: str, expected_mode: int | None = None) -> Path:
    if not isinstance(value, str):
        refuse(f"{label} must be a normalized absolute path")
    candidate = Path(value)
    if not candidate.is_absolute() or str(candidate) != os.path.normpath(value):
        refuse(f"{label} must be a normalized absolute path")
    info = candidate.lstat()
    if not stat.S_ISREG(info.st_mode) or candidate.is_symlink():
        refuse(f"{label} must be a regular non-symlink file")
    if expected_mode is not None and stat.S_IMODE(info.st_mode) != expected_mode:
        refuse(f"{label} mode drifted")
    if info.st_uid != os.getuid() or candidate.resolve() != candidate:
        refuse(f"{label} must be current-uid owned with no symlink ancestor")
    return candidate


def metadata_fingerprint(root: Path, excluded_top: frozenset[str] = frozenset()) -> str:
    rows: list[tuple[object, ...]] = []
    pending = [(root, "")]
    while pending:
        directory, parent = pending.pop()
        for candidate in sorted(directory.iterdir()):
            relative = f"{parent}/{candidate.name}" if parent else candidate.name
            if not parent and candidate.name in excluded_top:
                continue
            info = candidate.lstat()
            rows.append((
                relative,
                stat.S_IFMT(info.st_mode),
                stat.S_IMODE(info.st_mode),
                info.st_size,
                info.st_mtime_ns,
                info.st_dev,
                info.st_ino,
                info.st_nlink,
            ))
            if stat.S_ISDIR(info.st_mode):
                pending.append((candidate, relative))
    return sha256_bytes(json.dumps(rows, separators=(",", ":")).encode())


def validate_private_tree(root: Path, label: str) -> None:
    for candidate in root.rglob("*"):
        info = candidate.lstat()
        if info.st_uid != os.getuid():
            refuse(f"{label} contains an entry owned by another uid")
        if stat.S_ISLNK(info.st_mode) or not (
            stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)
        ):
            refuse(f"{label} contains a link or special entry")
        if stat.S_ISREG(info.st_mode) and info.st_nlink != 1:
            refuse(f"{label} contains a hardlinked file")


def audit_hook(event: str, args: tuple[object, ...]) -> None:
    if event == "subprocess.Popen" and _ALLOW_ALIAS_COLLISION_PROBE:
        executable = os.path.basename(str(args[0])) if args else ""
        argv = tuple(str(value) for value in args[1]) if len(args) > 1 else ()
        if executable == "which" and argv == ("which", "restored-cli"):
            return
    if event in {
        "socket.connect",
        "socket.bind",
        "socket.getaddrinfo",
        "subprocess.Popen",
        "os.system",
        "os.posix_spawn",
        "os.posix_spawnp",
    }:
        refuse(f"forbidden audited operation: {event}")


def write_fixture_file(root: Path, relative: str, profile: str) -> None:
    target = root.joinpath(*PurePosixPath(relative).parts)
    target.parent.mkdir(parents=True, exist_ok=True, mode=PRIVATE_DIR_MODE)
    target.write_bytes(f"SYNTHETIC_TASK_1_8::{profile}::{relative}\n".encode())
    target.chmod(PRIVATE_FILE_MODE)


def scenario_fixture(source_home: Path, scenario_home: Path) -> None:
    shutil.copytree(source_home, scenario_home)
    for profile, root in (
        ("default", scenario_home),
        ("atlas", scenario_home / "profiles" / "atlas"),
        ("beacon", scenario_home / "profiles" / "beacon"),
    ):
        original_session = root / "sessions" / f"session-{profile}.json"
        if not original_session.is_file():
            refuse("Task 1.6 source profile session fixture drifted")
        original_session.rename(root / "sessions" / "session.json")
        for relative in FIXTURE_FILES:
            write_fixture_file(root, relative, profile)


def classify(relative: str) -> str | None:
    if relative in {".env", "auth.json"} or relative == "pairing" or relative.startswith("pairing/"):
        return "authorization"
    if relative == "config.yaml":
        return "config"
    if relative == "SOUL.md":
        return "identity"
    if relative == "state.db" or relative.startswith("state.db-"):
        return "session_database"
    if relative == "cron/jobs.json":
        return "cron_definitions"
    if relative == "cron/executions.db":
        return "cron_executions"
    if relative == "cron/.jobs.lock":
        return "cron_lock"
    if relative == "external-state.json":
        return "external_declaration"
    if relative in {"gateway.pid", "gateway_state.json", "processes.json"}:
        return "machine_state"
    prefixes = {
        "memories": "memory",
        "skills": "skills",
        "sessions": "sessions",
        "cron/output": "cron_output",
        "hooks": "hooks",
        ".cache": "cache_log",
        "audio_cache": "cache_log",
        "image_cache": "cache_log",
        "logs": "cache_log",
    }
    for prefix, item_class in prefixes.items():
        if relative == prefix or relative.startswith(f"{prefix}/"):
            return item_class
    if relative == "cron":
        return "cron_definitions"
    return None


def tree_counts(root: Path) -> dict[str, int]:
    counts = {name: 0 for name in CLASS_ORDER}
    for candidate in root.rglob("*"):
        relative = candidate.relative_to(root).as_posix()
        item_class = classify(relative)
        if item_class is None:
            refuse("scenario or restored tree contains an unclassified member")
        counts[item_class] += 1
    return counts


def archive_counts(archive: Path, expected_root: str) -> tuple[dict[str, int], set[str]]:
    counts = {name: 0 for name in CLASS_ORDER}
    files: set[str] = set()
    with tarfile.open(archive, "r:gz") as handle:
        for member in handle.getmembers():
            parts = [part for part in PurePosixPath(member.name).parts if part not in {"", "."}]
            if not parts or parts[0] != expected_root:
                refuse("native archive root drifted")
            if len(parts) == 1:
                continue
            relative = PurePosixPath(*parts[1:]).as_posix()
            item_class = classify(relative)
            if item_class is None:
                refuse("native archive contains an unclassified member")
            if not (member.isdir() or member.isfile()):
                refuse("native archive contains a non-regular member")
            counts[item_class] += 1
            if member.isfile():
                files.add(relative)
    return counts, files


def file_hashes(root: Path) -> dict[str, str]:
    return {
        candidate.relative_to(root).as_posix(): sha256_file(candidate)
        for candidate in root.rglob("*")
        if candidate.is_file() and not candidate.is_symlink()
    }


def expected_file_sets() -> tuple[set[str], set[str]]:
    default = {
        relative
        for relative in FIXTURE_FILES
        if relative.split("/", 1)[0] in {
            "config.yaml",
            "SOUL.md",
            "skills",
            "cron",
            "sessions",
            "memories",
        }
    }
    named = set(FIXTURE_FILES) - {".env", "auth.json"}
    return default, named


def transfer_rows(
    source_counts: dict[str, int],
    default_archive: dict[str, int],
    named_archive: dict[str, int],
    default_import: dict[str, int],
    named_import: dict[str, int],
) -> list[dict[str, object]]:
    rows = []
    for item_class in CLASS_ORDER:
        rows.append({
            "logicalItemId": f"hermes.profile.{item_class}",
            "stateClass": {
                "authorization": "secret",
                "session_database": "runtime_state",
                "sessions": "runtime_state",
                "cron_definitions": "runtime_state",
                "cron_executions": "runtime_state",
                "cron_lock": "machine_local",
                "cron_output": "cache",
                "external_declaration": "external_state",
                "external_memory": "external_state",
                "machine_state": "machine_local",
                "cache_log": "cache",
                "alias": "reproducible",
            }.get(item_class, "portable_core"),
            "sourceEntryCount": source_counts[item_class],
            "default": {
                "archiveMemberCount": default_archive[item_class],
                "restoredEntryCount": default_import[item_class],
            },
            "named": {
                "archiveMemberCount": named_archive[item_class],
                "restoredEntryCount": named_import[item_class],
            },
        })
    return rows


def oracle_results(
    rows: list[dict[str, object]],
    isolation_proven: bool,
) -> list[dict[str, str]]:
    by_class = {row["logicalItemId"].rsplit(".", 1)[-1]: row for row in rows}

    def present(profile: str, item_class: str) -> bool:
        return bool(by_class[item_class][profile]["restoredEntryCount"])

    results = {
        "HERMES-RO-PROFILE-ISOLATION-001": (
            "pass" if isolation_proven else "fail",
            "pass" if isolation_proven else "fail",
            "original_selected_and_sibling_profile_fingerprints_stable",
        ),
        "HERMES-RO-CORE-CONFIG-001": ("pass", "pass", "round_trip_content_equal"),
        "HERMES-RO-CORE-IDENTITY-001": ("pass", "pass", "round_trip_content_equal"),
        "HERMES-RO-CORE-MEMORY-DOCS-001": ("pass", "pass", "round_trip_content_equal"),
        "HERMES-RO-CORE-SKILLS-001": ("pass", "pass", "round_trip_content_equal"),
        "HERMES-RO-CORE-HOOKS-001": (
            "pass" if present("default", "hooks") else "fail",
            "pass" if present("named", "hooks") else "fail",
            "native_membership_and_round_trip",
        ),
        "HERMES-RO-SESSION-FILES-001": ("pass", "pass", "round_trip_content_equal"),
        "HERMES-RO-SESSION-DB-001": (
            "pass" if present("default", "session_database") else "fail",
            "pass" if present("named", "session_database") else "fail",
            "native_membership_only_database_safety_separate",
        ),
        "HERMES-RO-CRON-DEFINITIONS-001": ("pass", "pass", "round_trip_content_equal"),
        "HERMES-RO-CRON-EXECUTIONS-001": ("pass", "pass", "round_trip_content_equal"),
        "HERMES-RO-SECRETS-EXCLUDED-001": (
            "pass" if not present("default", "authorization") else "fail",
            "pass" if not present("named", "authorization") else "fail",
            "all_authorization_state_must_be_absent",
        ),
        "HERMES-RO-EXTERNAL-MEMORY-001": ("fail", "fail", "external_payload_not_transferred"),
        "HERMES-RO-MACHINE-LOCAL-001": ("fail", "fail", "machine_local_state_transferred"),
        "HERMES-RO-ALIAS-001": ("fail", "fail", "source_custom_alias_name_not_preserved"),
        "HERMES-RO-TARGET-COLLISION-001": ("pass", "pass", "existing_target_refused_without_overlay"),
        "HERMES-RO-DB-INTEGRITY-001": ("blocked", "blocked", "requires_task_1_11"),
        "HERMES-RO-DB-SCHEMA-001": ("blocked", "blocked", "requires_task_1_11"),
        "HERMES-RO-DB-CANARY-001": ("blocked", "blocked", "requires_task_1_11"),
        "HERMES-RO-DB-WAL-001": ("blocked", "blocked", "requires_task_1_11"),
    }
    output = []
    for check_id in ORACLE_IDS:
        default, named, reason = results[check_id]
        row = {"checkId": check_id, "default": default, "named": named, "reason": reason}
        if default == "blocked" or named == "blocked":
            row["dependency"] = "task_1_11"
        output.append(row)
    return output


def run_probe(request: dict[str, object]) -> dict[str, object]:
    allowed = {"sourceHome", "workRoot", "hermesWheel", "outputPath", "executionClass"}
    if not isinstance(request, dict) or set(request) != allowed:
        refuse("request schema mismatch")
    source_home = canonical_directory(request["sourceHome"], "source home")
    work_root = canonical_directory(request["workRoot"], "work root", empty=True)
    wheel = canonical_file(request["hermesWheel"], "Hermes wheel")
    output = Path(str(request["outputPath"]))
    if not output.is_absolute() or str(output) != os.path.normpath(str(output)):
        refuse("output path must be normalized and absolute")
    if output.parent != work_root or output.exists():
        refuse("output must be a new direct child of the work root")
    if request["executionClass"] not in {"local_discovery_nonclosing", "github_actions_exact_lane"}:
        refuse("execution class is invalid")
    live_home = Path.home().resolve()
    if contained(live_home, source_home) or contained(source_home, live_home):
        refuse("source home overlaps the live user home")
    if contained(live_home, work_root) or contained(work_root, live_home):
        refuse("work root overlaps the live user home")
    if sha256_file(wheel) != HERMES_WHEEL_SHA256:
        refuse("Hermes wheel digest drifted")
    with zipfile.ZipFile(wheel) as archive:
        if sha256_bytes(archive.read("hermes_cli/profiles.py")) != PROFILES_SOURCE_SHA256:
            refuse("Hermes profiles.py digest drifted")

    validate_private_tree(source_home, "source home")
    source_before = metadata_fingerprint(source_home)
    scenario_home = work_root / "scenario-home"
    user_home = work_root / "user-home"
    evidence = work_root / "native"
    user_home.mkdir(mode=PRIVATE_DIR_MODE)
    evidence.mkdir(mode=PRIVATE_DIR_MODE)
    scenario_fixture(source_home, scenario_home)
    validate_private_tree(scenario_home, "scenario home")
    external = user_home / ".honcho" / "config.json"
    external.parent.mkdir(mode=PRIVATE_DIR_MODE)
    external.write_text("SYNTHETIC_TASK_1_8_EXTERNAL\n")
    external.chmod(PRIVATE_FILE_MODE)

    os.environ.update({
        "HOME": str(user_home),
        "HERMES_HOME": str(scenario_home),
        "PYTHONNOUSERSITE": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "HERMES_DISABLE_LAZY_INSTALLS": "1",
        "HTTP_PROXY": "http://127.0.0.1:9",
        "HTTPS_PROXY": "http://127.0.0.1:9",
        "ALL_PROXY": "http://127.0.0.1:9",
        "NO_PROXY": "",
        "PATH": "/usr/bin:/bin",
        "TMPDIR": str(evidence),
        "XDG_CACHE_HOME": str(user_home / ".cache"),
        "XDG_CONFIG_HOME": str(user_home / ".config"),
        "XDG_DATA_HOME": str(user_home / ".local" / "share"),
    })
    sys.addaudithook(audit_hook)
    sys.path.insert(0, str(wheel))
    profiles = importlib.import_module("hermes_cli.profiles")
    if not str(profiles.__file__).startswith(f"{wheel}/"):
        refuse("Hermes profiles module did not load from the verified wheel")
    if importlib.metadata.version("hermes-agent") != HERMES_VERSION:
        refuse("Hermes installed metadata version drifted")

    with open(os.devnull, "w", encoding="utf-8") as sink, contextlib.redirect_stdout(sink):
        alias = profiles.create_wrapper_script("navigator", target="atlas")
    if alias is None or not alias.is_file():
        refuse("native source alias creation failed")
    original_profile_fingerprints = {
        "default": metadata_fingerprint(scenario_home, frozenset({"profiles"})),
        "atlas": metadata_fingerprint(scenario_home / "profiles" / "atlas"),
        "beacon": metadata_fingerprint(scenario_home / "profiles" / "beacon"),
    }

    default_archive = evidence / "default.tar.gz"
    named_archive = evidence / "atlas.tar.gz"
    default_target = scenario_home / "profiles" / "restored-default"
    named_target = scenario_home / "profiles" / "restored-atlas"
    try:
        with open(os.devnull, "w", encoding="utf-8") as sink, contextlib.redirect_stdout(sink):
            profiles.export_profile("default", str(default_archive))
            profiles.export_profile("atlas", str(named_archive))
        default_counts, default_files = archive_counts(default_archive, "default")
        named_counts, named_files = archive_counts(named_archive, "atlas")
        expected_default, expected_named = expected_file_sets()
        if default_files != expected_default or named_files != expected_named:
            refuse("native archive file membership drifted")

        with open(os.devnull, "w", encoding="utf-8") as sink, contextlib.redirect_stdout(sink):
            restored_default = profiles.import_profile(str(default_archive), "restored-default")
            restored_named = profiles.import_profile(str(named_archive), "restored-atlas")
        if restored_default != default_target or restored_named != named_target:
            refuse("native import target drifted")
        default_import_counts = tree_counts(default_target)
        named_import_counts = tree_counts(named_target)
        if file_hashes(default_target) != {
            name: sha256_file(scenario_home / name) for name in expected_default
        }:
            refuse("default round-trip file content drifted")
        atlas = scenario_home / "profiles" / "atlas"
        if file_hashes(named_target) != {
            name: sha256_file(atlas / name) for name in expected_named
        }:
            refuse("named round-trip file content drifted")

        collision_refused = False
        try:
            profiles.import_profile(str(named_archive), "restored-atlas")
        except FileExistsError:
            collision_refused = True
        default_target_refused = False
        try:
            profiles.import_profile(str(default_archive), "default")
        except ValueError:
            default_target_refused = True
        if not collision_refused or not default_target_refused:
            refuse("native import refusal semantics drifted")

        source_counts = tree_counts(atlas)
        source_counts["external_memory"] = 1
        source_counts["alias"] = 1
        rows = transfer_rows(
            source_counts,
            default_counts,
            named_counts,
            default_import_counts,
            named_import_counts,
        )

        global _ALLOW_ALIAS_COLLISION_PROBE
        _ALLOW_ALIAS_COLLISION_PROBE = True
        try:
            collision = profiles.check_alias_collision("restored-cli")
        finally:
            _ALLOW_ALIAS_COLLISION_PROBE = False
        with open(os.devnull, "w", encoding="utf-8") as sink, contextlib.redirect_stdout(sink):
            restored_cli = profiles.import_profile(str(named_archive), "restored-cli")
            restored_cli_alias = profiles.create_wrapper_script("restored-cli")
        if collision is not None:
            refuse("CLI-equivalent target alias unexpectedly collides")
        if restored_cli.name != "restored-cli" or restored_cli_alias is None or \
                profiles.find_alias_for_profile("restored-cli") != "restored-cli":
            refuse("CLI-equivalent import alias recreation drifted")
        if profiles.find_alias_for_profile("atlas") != "navigator":
            refuse("source custom alias fixture drifted")
        if not profiles.remove_wrapper_script("restored-cli"):
            refuse("CLI-equivalent target alias cleanup failed")
        shutil.rmtree(restored_cli)
    finally:
        default_archive.unlink(missing_ok=True)
        named_archive.unlink(missing_ok=True)

    if any(evidence.iterdir()):
        refuse("raw native profile archives were retained")
    if metadata_fingerprint(source_home) != source_before:
        refuse("Task 1.6 source home changed during probe")
    if profiles.find_alias_for_profile("restored-default") is not None or \
            profiles.find_alias_for_profile("restored-atlas") is not None:
        refuse("direct native import unexpectedly recreated an alias")
    isolation_proven = original_profile_fingerprints == {
        "default": metadata_fingerprint(scenario_home, frozenset({"profiles"})),
        "atlas": metadata_fingerprint(scenario_home / "profiles" / "atlas"),
        "beacon": metadata_fingerprint(scenario_home / "profiles" / "beacon"),
    }
    if not isolation_proven:
        refuse("an original scenario profile changed during native transfer")

    result = {
        "schema": "agentbootup.hermes-m0h-profile-transfer/v1",
        "qualification": "task_1_8_evidence_only",
        "executionClass": request["executionClass"],
        "hermes": {
            "package": HERMES_VERSION,
            "tag": "v2026.7.20",
            "commit": HERMES_COMMIT,
            "wheelSha256": HERMES_WHEEL_SHA256,
            "profilesSourceSha256": PROFILES_SOURCE_SHA256,
        },
        "trustBoundary": "disposable_private_clone_socket_guard_fixed_alias_collision_subprocess",
        "nativeBehavior": {
            "defaultExportPolicy": "root_allowlist",
            "namedExportPolicy": "recursive_except_exact_env_and_auth",
            "defaultImportTarget": "named_only",
            "existingTarget": "refused_no_overlay",
            "sourceAlias": "outside_profile_archive",
            "directImportAlias": "not_recreated",
            "cliImportAlias": "target_wrapper_recreated_source_custom_name_not_preserved",
            "externalMemory": "outside_profile_archive",
            "rawArchivesRetained": False,
            "sourceHomeStable": True,
        },
        "rows": rows,
        "restoreOracleDraft": oracle_results(rows, isolation_proven),
        "decision": "native_profile_transfer_requires_filtering_and_supplements",
        "blockers": [
            "default_export_omits_session_database_and_hooks",
            "named_export_includes_pairing_machine_state_caches_and_logs",
            "both_exports_include_cron_lock",
            "external_memory_payload_omitted",
            "source_custom_alias_not_preserved",
            "database_safety_pending_task_1_11",
        ],
    }
    encoded = json.dumps(result, sort_keys=True, separators=(",", ":"))
    forbidden = (
        str(source_home),
        str(work_root),
        "SYNTHETIC_TASK_1_8",
        ".env",
        "auth.json",
        "telegram-approved",
        "gateway.pid",
    )
    if any(value in encoded for value in forbidden):
        refuse("structured result contains forbidden path or fixture material")
    return result


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[0] != "--request":
        refuse("usage: hermes-m0h-profile-transfer-probe.py --request /absolute/request.json")
    request_path = canonical_file(argv[1], "request", PRIVATE_FILE_MODE)
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
