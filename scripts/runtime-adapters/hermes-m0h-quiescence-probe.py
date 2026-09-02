#!/usr/bin/env python3
"""Evidence-only Task 1.10 source and lifecycle-model probe."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import zipfile

HERMES_VERSION = "0.19.0"
HERMES_TAG = "v2026.7.20"
HERMES_COMMIT = "3ef6bbd201263d354fd83ec55b3c306ded2eb72a"
HERMES_WHEEL_SHA256 = "bd0bac012aee38a60894781f4597dc29ee7bedb3448540249921f10d3bef327f"
PRIVATE_FILE_MODE = 0o600

SOURCE_SPECS = {
    "gateway_cli": (
        "hermes_cli/gateway.py",
        "ed105fe335d5d46ae94f57a85e68839de3e0a2de76093b01aed039d0d5862d76",
        ("class GatewayRuntimeSnapshot:", "def stop_profile_gateway()", "all_profiles=True"),
    ),
    "profiles": (
        "hermes_cli/profiles.py",
        "dbfd34e5852e61ea501669d8b5db99e6a7e119b8ce4975e2211ea9546de1ac7b",
        ("def profiles_to_serve(multiplex: bool)", "def _profile_bound_backend_pids"),
    ),
    "main": (
        "hermes_cli/main.py",
        "d6bf89a33fb708376a7ab354cff8081a3c3726dbfb91d84bbb679cd667db596c",
        ('"cron": ("cron_command", {"run", "tick"})', '_AGENT_COMMANDS = {None, "chat", "acp", "rl"}'),
    ),
    "desktop": (
        "hermes_cli/web_server.py",
        "0bf9d4dd17a1b7c3d96c94dacea9884426e7bbb5c8818685b43ef68f2465b3f2",
        ("def _start_desktop_cron_ticker", 'if os.getenv("HERMES_DESKTOP") == "1"'),
    ),
    "active_sessions": (
        "hermes_cli/active_sessions.py",
        "f00cd7a46514f872f0675e5221eb0778d12c21f102f9cc812cbfc396642b765b",
        ("Cross-process active chat session leases.", "active_sessions.json"),
    ),
    "session_db": (
        "hermes_state.py",
        "0c6bc23bf4bfbc3c9410765cd49e65b7aee40e9e01eb733372f0fe7ac9bd64ef",
        ("multiple hermes processes (gateway + CLI sessions + worktree agents)", "gateway + cron"),
    ),
    "gateway_runtime": (
        "gateway/run.py",
        "c6e0f443772e4a8a7eac0d9ccf9a4f659de5fc5493c572a69a46e4c61a8aa966",
        ("cron_provider = resolve_cron_scheduler()", "cron_stop.set()", "cron_provider.stop()"),
    ),
    "cron_store": (
        "cron/jobs.py",
        "d6985aac9539bed19fc6a90f061249fd647c32d2de101305ac9617aa89de204f",
        ("Cron is per-profile by design", "degrades to in-process locking only"),
    ),
    "cron_provider": (
        "cron/scheduler_provider.py",
        "e3da8ce5a731957bf146966ffcc80313c6603279bb54882c668bfbe27ac2c7a4",
        ("class InProcessCronScheduler", "An external provider may register a schedule/webhook"),
    ),
    "file_tools": (
        "tools/file_tools.py",
        "ca0d8ef54d9b164c20c475652fa18b5faf3f881db2d19c5244a8a9c565df0c5f",
        ("All detectors are soft guards", "cross_profile=True"),
    ),
    "service_manager": (
        "hermes_cli/service_manager.py",
        "e346a32c3a4350c87421eb5dc511a8e84a87574372292a0ab9d17fb47af88aeb",
        ('_write_gateway_desired_state(name, "stopped")', '_write_gateway_desired_state(name, "running")'),
    ),
    "memory_manager": (
        "agent/memory_manager.py",
        "422c416b809cdabac79d4ec10740a74be2598ce60edcc51d122819c7e4c7ea89",
        ("def on_memory_write(", "provider.on_memory_write(", "def notify_memory_tool_write("),
    ),
}

ORACLE_IDS = (
    "HERMES-RO-WRITER-CENSUS-001",
    "HERMES-RO-QUIESCENCE-SCOPE-001",
    "HERMES-RO-QUIESCENCE-ZERO-WRITERS-001",
    "HERMES-RO-QUIESCENCE-STABILITY-001",
    "HERMES-RO-SIBLING-CONSENT-001",
    "HERMES-RO-GATEWAY-DRAIN-001",
    "HERMES-RO-CRON-DRAIN-001",
    "HERMES-RO-PROCESS-STATE-RESTORE-001",
    "HERMES-RO-STOPPED-NOT-STARTED-001",
    "HERMES-RO-QUIESCE-CRASH-RECOVERY-001",
    "HERMES-RO-UNKNOWN-WRITER-FAIL-CLOSED-001",
)


def refuse(message: str) -> None:
    raise RuntimeError(f"Hermes quiescence probe refused: {message}")


def helpers_module():
    path = Path(__file__).with_name("hermes-m0h-profile-transfer-probe.py")
    spec = importlib.util.spec_from_file_location("hermes_profile_transfer_helpers", path)
    if spec is None or spec.loader is None:
        refuse("cannot load profile-transfer validation helpers")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HELPERS = helpers_module()


def source_evidence(wheel: Path) -> list[dict[str, object]]:
    rows = []
    with zipfile.ZipFile(wheel) as handle:
        for source_id, (member, expected_digest, anchors) in SOURCE_SPECS.items():
            raw = handle.read(member)
            if hashlib.sha256(raw).hexdigest() != expected_digest:
                refuse(f"{source_id} source digest drifted")
            text = raw.decode("utf-8")
            if any(anchor not in text for anchor in anchors):
                refuse(f"{source_id} source anchor drifted")
            rows.append({
                "sourceId": source_id,
                "sha256": expected_digest,
                "anchorCount": len(anchors),
            })
    return rows


def writer_matrix() -> list[dict[str, object]]:
    return [
        {"storeId": "core_config", "writerClasses": ["management_cli", "dashboard", "agent_surface", "generic_file_tool"], "treatment": "installation_writer_fence"},
        {"storeId": "core_identity", "writerClasses": ["management_cli", "dashboard", "generic_file_tool"], "treatment": "installation_writer_fence"},
        {"storeId": "memory_documents", "writerClasses": ["gateway_agent", "cron_agent", "interactive_agent", "dashboard", "memory_plugin", "generic_file_tool"], "treatment": "installation_writer_fence"},
        {"storeId": "skills", "writerClasses": ["skill_manager", "dashboard", "agent_surface", "generic_file_tool"], "treatment": "installation_writer_fence"},
        {"storeId": "hooks", "writerClasses": ["management_cli", "dashboard", "gateway_agent", "generic_file_tool"], "treatment": "installation_writer_fence"},
        {"storeId": "session_files", "writerClasses": ["gateway", "cli", "tui", "acp", "dashboard", "worktree_agent"], "treatment": "installation_writer_fence_and_lease_check"},
        {"storeId": "session_database", "writerClasses": ["gateway", "cli", "tui", "acp", "dashboard", "cron_agent", "worktree_agent"], "treatment": "installation_writer_fence_then_sqlite_api"},
        {"storeId": "cron_definitions", "writerClasses": ["gateway", "desktop_backend", "cron_cli", "dashboard", "cron_tool", "external_scheduler_webhook"], "treatment": "installation_writer_fence"},
        {"storeId": "cron_executions", "writerClasses": ["gateway", "desktop_backend", "cron_cli", "external_scheduler_webhook"], "treatment": "installation_writer_fence_then_sqlite_api"},
        {"storeId": "cron_output", "writerClasses": ["gateway", "desktop_backend", "cron_cli", "external_scheduler_webhook"], "treatment": "installation_writer_fence"},
        {"storeId": "external_memory_declaration", "writerClasses": ["management_cli", "provider_setup"], "treatment": "sanitize_declaration_external_payload_separate"},
        {"storeId": "external_memory_payload", "writerClasses": ["memory_provider", "provider_backend", "external_service"], "treatment": "provider_specific_unqualified_task_9"},
        {"storeId": "machine_local_runtime", "writerClasses": ["gateway", "desktop_backend", "service_manager", "cron_scheduler"], "treatment": "observe_for_lifecycle_exclude_from_payload"},
        {"storeId": "authorization", "writerClasses": ["auth_cli", "oauth_flow", "pairing_gateway", "setup"], "treatment": "exclude_from_default_payload_and_evidence"},
    ]


def resume_authorized(component: dict[str, object]) -> bool:
    return bool(component["originallyRunning"] and component["stoppedByWrapper"])


def lifecycle_scenarios() -> list[dict[str, object]]:
    scenarios = []

    def add(scenario_id: str, outcome: str, starts: int, stopped_tripwire: bool, **facts: object) -> None:
        scenarios.append({
            "scenarioId": scenario_id,
            "outcome": outcome,
            "authorizedStartCount": starts,
            "originallyStoppedStartTripwireClear": stopped_tripwire,
            **facts,
        })

    stopped = {"originallyRunning": False, "stoppedByWrapper": False}
    running_stopped = {"originallyRunning": True, "stoppedByWrapper": True}
    running_not_stopped = {"originallyRunning": True, "stoppedByWrapper": False}
    add("all_stopped", "quiesced", 0, not resume_authorized(stopped), consentRequired=True)
    add("running_gateway_without_consent", "sibling_consent_required", 0, True, consentRequired=True)
    add("one_running_gateway", "resume_original_owner", 1, not resume_authorized(stopped),
        consentRequired=True, cronStartIssued=False, ownerStartIssued=True)
    add("two_running_gateways", "resume_original_owners", 2, not resume_authorized(stopped),
        consentRequired=True, cronStartIssued=False, ownerStartIssued=True)
    add("multiplex_gateway", "installation_scope", 1, True, consentRequired=True,
        siblingProfilesAffected=True, cronStartIssued=False)
    for scenario_id in (
        "desktop_backend",
        "gateway_and_desktop_competing",
        "interactive_lease",
        "standalone_cron",
        "unknown_writer",
        "uninspectable_writer",
        "unmanaged_writer",
    ):
        add(scenario_id, "writer_busy_unsupported", 0, True, consentRequired=True)
    add("cross_profile_writer", "installation_scope", 0, True, consentRequired=True)
    add("drain_timeout", "safe_stopped", 0, True, captureAuthorized=False)
    add("supervisor_restart_race", "writer_busy_unsupported", 0, True, captureAuthorized=False)
    add("resume_failure", "safe_stopped", 1, True, partialResumeFailureRecorded=True)
    if not resume_authorized(running_stopped):
        refuse("resume model rejected an originally running component stopped by the wrapper")
    if resume_authorized(running_not_stopped):
        refuse("resume model authorized a component not stopped by the wrapper")

    phases = ("observed", "quiescing", "quiesced", "capturing", "captured", "resuming", "complete")
    recovery = {
        "observed": "abandon_without_start",
        "quiescing": "reconcile_known_stops_only",
        "quiesced": "cleanup_owned_staging_then_resume",
        "capturing": "cleanup_owned_staging_then_resume",
        "captured": "preserve_ciphertext_then_resume",
        "resuming": "verify_before_idempotent_start",
        "complete": "no_action",
    }
    for phase in phases:
        add(
            f"crash_{phase}",
            recovery[phase],
            1 if phase in {"quiesced", "capturing", "captured", "resuming"} else 0,
            True,
            journalPhase=phase,
            ambiguousJournalOutcome="safe_stopped_manual_recovery",
        )
    return scenarios


def oracle_extensions() -> list[dict[str, str]]:
    proven = {
        "HERMES-RO-WRITER-CENSUS-001": ("pass", "pinned_source_writer_classes_accounted"),
        "HERMES-RO-QUIESCENCE-SCOPE-001": ("pass", "pinned_source_requires_installation_scope"),
        "HERMES-RO-SIBLING-CONSENT-001": ("pass", "model_requires_consent_before_any_stop"),
        "HERMES-RO-STOPPED-NOT-STARTED-001": ("pass", "model_negative_start_tripwire_clear"),
        "HERMES-RO-QUIESCE-CRASH-RECOVERY-001": ("pass", "journal_authorization_model_complete"),
        "HERMES-RO-UNKNOWN-WRITER-FAIL-CLOSED-001": ("pass", "model_blocks_unknown_and_uninspectable_writers"),
    }
    rows = []
    for check_id in ORACLE_IDS:
        status, reason = proven.get(check_id, ("blocked", "requires_task_4_native_lifecycle_implementation"))
        row = {"checkId": check_id, "status": status, "reason": reason}
        if status == "blocked":
            row["dependency"] = "task_4"
        rows.append(row)
    return rows


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
    for candidate in (source_home, work_root):
        if HELPERS.contained(live_home, candidate) or HELPERS.contained(candidate, live_home):
            refuse("disposable root overlaps the live user home")
    if HELPERS.sha256_file(wheel) != HERMES_WHEEL_SHA256:
        refuse("Hermes wheel digest drifted")
    HELPERS.validate_private_tree(source_home, "source home")
    source_before = HELPERS.metadata_fingerprint(source_home)
    sources = source_evidence(wheel)
    matrix = writer_matrix()
    scenarios = lifecycle_scenarios()
    if HELPERS.metadata_fingerprint(source_home) != source_before:
        refuse("source home changed during source/model probe")
    if len(matrix) != 14 or len(scenarios) != 23 or len(sources) != len(SOURCE_SPECS):
        refuse("evidence cardinality drifted")
    if any(
        row["outcome"] == "writer_busy_unsupported" and row["authorizedStartCount"] != 0
        for row in scenarios
    ):
        refuse("blocked writer scenario authorized a start")
    result = {
        "schema": "agentbootup.hermes-m0h-quiescence/v1",
        "qualification": "task_1_10_evidence_only",
        "executionClass": execution_class,
        "hermes": {
            "package": HERMES_VERSION,
            "tag": HERMES_TAG,
            "commit": HERMES_COMMIT,
            "wheelSha256": HERMES_WHEEL_SHA256,
        },
        "trustBoundary": (
            "disposable_exact_source_no_egress_lifecycle_model_same_uid_no_concurrent_mutation"
            if execution_class == "github_actions_exact_lane"
            else "disposable_exact_source_lifecycle_model_same_uid_no_concurrent_mutation"
        ),
        "sourceEvidence": sources,
        "writerMatrix": matrix,
        "scopeDecision": {
            "scope": "installation_wide",
            "profileScopedSafe": False,
            "siblingConsentRequired": True,
            "unknownWriterFailsClosed": True,
            "twoStableZeroWriterObservationsRequired": True,
            "nativeLifecycleActuationTested": False,
        },
        "cronLifecycle": {
            "builtInOwner": "gateway_or_desktop_backend",
            "separateDaemon": False,
            "separateStartAllowed": False,
            "externalProviderStateQualified": False,
        },
        "lifecycleModel": {
            "journalPhases": ["observed", "quiescing", "quiesced", "capturing", "captured", "resuming", "complete"],
            "resumeRule": "originally_running_and_stopped_by_wrapper_only",
            "resumeFailureOutcome": "safe_stopped",
            "ambiguousRecoveryOutcome": "safe_stopped_manual_recovery",
            "scenarios": scenarios,
        },
        "restoreOracleExtensions": oracle_extensions(),
        "decision": "installation_wide_quiescence_required",
        "blockers": [
            "native_zero_writer_census_pending_task_4",
            "native_gateway_and_cron_drain_pending_task_4",
            "native_service_state_restore_pending_task_4",
            "macos_launchd_lifecycle_unqualified",
            "external_scheduler_state_not_locally_quiesced",
            "external_memory_payload_quiescence_pending_task_9",
        ],
    }
    encoded = json.dumps(result, sort_keys=True, separators=(",", ":"))
    forbidden = (
        str(source_home),
        str(work_root),
        "SYNTHETIC_SECRET_DO_NOT_USE_",
        "gateway.pid",
        "active_sessions.json",
        ".env",
        "auth.json",
        "/home/",
        "/Users/",
    )
    if any(value in encoded for value in forbidden):
        refuse("structured result contains forbidden path or fixture material")
    return result


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[0] != "--request":
        refuse("usage: hermes-m0h-quiescence-probe.py --request /absolute/request.json")
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
