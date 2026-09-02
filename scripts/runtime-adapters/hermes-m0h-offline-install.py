#!/usr/bin/env python3
"""Build the disposable Hermes M0-H Linux installation without network access."""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tarfile
import tomllib
import zipfile

PINS = {
    "hermes_agent-0.19.0-py3-none-any.whl": "bd0bac012aee38a60894781f4597dc29ee7bedb3448540249921f10d3bef327f",
    "python-3.13.13-linux-24.04-x64.tar.gz": "4254187c63019c6af254b3420596c1134376c2c1f99ad09dddde3cb8f67862db",
    "uv-x86_64-unknown-linux-gnu.tar.gz": "aab924fd522efd06f1c5f3b93a243864fc453132c94b2dc49f1371b528a4b967",
    "requirements.txt": "317e6f4a0dbf56999fafafcefe481dcd49cd64995d657592c08b3e7acaee0971",
}
LOCK_SHA256 = "456f76d5396df0f543d1035c2d05173cae1882c290ba585cc926a79958b9d7fe"
PRIVATE_DIRECTORY = 0o700
PRIVATE_FILE = 0o600
CLOSURE_AUTHORITY = "config/hermes-m0h-closure-authority-v1.json"


def refuse(message: str) -> "NoReturn":
    raise SystemExit(f"Hermes offline install refused: {message}")


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()

def fingerprint_private_tree(root: Path) -> dict[str, str]:
    rows: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        info = path.lstat()
        relative = str(path.relative_to(root))
        if stat.S_ISLNK(info.st_mode) or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
            refuse(f"private input tree contains a symlink or special file: {relative}")
        if info.st_uid != os.getuid():
            refuse(f"private input tree contains an entry owned by another uid: {relative}")
        if stat.S_ISREG(info.st_mode):
            rows[relative] = digest(path)
    return rows


def normalized_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).lower()


def private_root(value: str, label: str, *, empty: bool = False) -> Path:
    root = Path(value)
    if not root.is_absolute() or os.path.normpath(value) != value:
        refuse(f"{label} must be a normalized absolute path")
    info = root.lstat() if root.exists() else None
    if info is None or not stat.S_ISDIR(info.st_mode) or root.is_symlink():
        refuse(f"{label} must be an existing non-symlink directory")
    if stat.S_IMODE(info.st_mode) != PRIVATE_DIRECTORY or info.st_uid != os.getuid():
        refuse(f"{label} must be mode 0700 and owned by the current uid")
    if root.resolve() != root:
        refuse(f"{label} or one of its ancestors is a symlink")
    if empty and any(root.iterdir()):
        refuse(f"{label} must be empty")
    return root


def protected_root(value: str, label: str) -> Path:
    root = Path(value)
    if not root.is_absolute() or os.path.normpath(value) != value:
        refuse(f"{label} must be a normalized absolute path")
    info = root.lstat() if root.exists() else None
    if info is None or not stat.S_ISDIR(info.st_mode) or root.is_symlink():
        refuse(f"{label} must be an existing non-symlink directory")
    if info.st_uid != os.getuid() or root.resolve() != root:
        refuse(f"{label} must be owned by the current uid with no symlink ancestors")
    return root


def overlaps(left: Path, right: Path) -> bool:
    return left == right or left in right.parents or right in left.parents


def clean_validated_install(root: Path, identity: tuple[int, int]) -> None:
    """Clean only the same already-validated root; never follow replacement links."""
    try:
        info = root.lstat()
        if (not stat.S_ISDIR(info.st_mode) or root.is_symlink() or
                info.st_uid != os.getuid() or (info.st_dev, info.st_ino) != identity):
            return
        for child in root.iterdir():
            if child.is_symlink() or child.is_file():
                child.unlink()
            elif child.is_dir():
                shutil.rmtree(child)
    except OSError:
        # Preserve the original refusal. A caller can discard this disposable
        # root if a concurrent same-UID actor defeats best-effort cleanup.
        pass


def safe_archive_name(name: str) -> bool:
    candidate = PurePosixPath(name.removeprefix("./"))
    return str(candidate) not in ("", ".") and not candidate.is_absolute() and ".." not in candidate.parts


def validate_tar(archive: tarfile.TarFile, *, expected_uv: bool = False) -> None:
    seen: set[str] = set()
    uv_members = 0
    for member in archive.getmembers():
        if member.name in (".", "./"):
            continue
        relative = member.name.removeprefix("./").rstrip("/")
        if not relative:
            continue
        if not safe_archive_name(member.name) or relative in seen:
            refuse(f"archive contains an unsafe or duplicate member: {member.name}")
        seen.add(relative)
        if not (member.isdir() or member.isfile() or member.issym()):
            refuse("archive contains an unsupported member type")
        if member.issym():
            target = PurePosixPath(relative).parent.joinpath(member.linkname)
            if PurePosixPath(member.linkname).is_absolute() or ".." in target.parts:
                refuse("archive symlink escapes extraction root")
        if expected_uv and member.isfile() and member.name == "uv-x86_64-unknown-linux-gnu/uv":
            uv_members += 1
    if expected_uv and uv_members != 1:
        refuse("uv archive does not contain exactly one uv executable")


def verify_wheel(path: Path) -> tuple[str, str]:
    if path.name != str(path.name) or path.suffix != ".whl":
        refuse(f"non-wheel artifact in wheelhouse: {path.name}")
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or any(not safe_archive_name(name) for name in names):
            refuse(f"unsafe or duplicate wheel member: {path.name}")
        records = [name for name in names if name.endswith(".dist-info/RECORD")]
        metadata = [name for name in names if name.endswith(".dist-info/METADATA")]
        if len(records) != 1 or len(metadata) != 1:
            refuse(f"ambiguous wheel metadata: {path.name}")
        for name, encoded, size in csv.reader(archive.read(records[0]).decode().splitlines()):
            if name == records[0]:
                continue
            if name not in names:
                refuse(f"wheel RECORD names a missing member: {path.name}")
            data = archive.read(name)
            actual = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip("=")
            if encoded != f"sha256={actual}" or int(size) != len(data):
                refuse(f"wheel RECORD mismatch: {path.name}:{name}")
        headers: dict[str, str] = {}
        for line in archive.read(metadata[0]).decode().splitlines():
            if ": " in line:
                key, value = line.split(": ", 1)
                headers.setdefault(key, value)
        if not headers.get("Name") or not headers.get("Version"):
            refuse(f"wheel identity metadata missing: {path.name}")
        return normalized_name(headers["Name"]), headers["Version"]


def run(command: list[str], *, cwd: Path, runtime: Path) -> None:
    environment = {
        "HOME": str(cwd),
        "PATH": "",
        "LANG": "C",
        "LC_ALL": "C",
        "TZ": "UTC",
        "PYTHONNOUSERSITE": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "UV_CACHE_DIR": str(cwd / ".uv-cache"),
        "UV_NO_CACHE": "1",
        "HTTP_PROXY": "http://127.0.0.1:9",
        "HTTPS_PROXY": "http://127.0.0.1:9",
        "ALL_PROXY": "http://127.0.0.1:9",
        "NO_PROXY": "",
        "LD_LIBRARY_PATH": str(runtime / "lib"),
    }
    result = subprocess.run(
        command, cwd=cwd, env=environment, stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180, check=False,
    )
    if result.returncode:
        refuse(f"bounded offline command failed: {Path(command[0]).name} {command[1]}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--quarantine", required=True)
    parser.add_argument("--install-root", required=True)
    parser.add_argument("--lock", required=True)
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--workspace-root", action="append", required=True)
    args = parser.parse_args()
    install = private_root(args.install_root, "installation root", empty=True)
    install_identity = (install.stat().st_dev, install.stat().st_ino)
    try:
        quarantine = private_root(args.quarantine, "quarantine")
        repo = protected_root(args.repo_root, "repository root")
        workspaces = [
            protected_root(value, f"workspace root {index}")
            for index, value in enumerate(args.workspace_root, start=1)
        ]
        if len(workspaces) != len(set(workspaces)):
            refuse("workspace roots must be unique")
        live_home = Path.home().resolve()
        for disposable in (quarantine, install):
            if overlaps(live_home, disposable):
                refuse("private disposable root overlaps the live home")
            for protected in (repo, *workspaces):
                if overlaps(protected, disposable):
                    refuse("private disposable root overlaps the repository or a workspace")
        if overlaps(quarantine, install):
            refuse("quarantine and installation root overlap")
        lock = Path(args.lock)
        if not lock.is_absolute() or lock.resolve() != lock or digest(lock) != LOCK_SHA256:
            refuse("dependency lock is not the exact pin")
        authority_path = repo / CLOSURE_AUTHORITY
        try:
            authority = json.loads(authority_path.read_text())
        except (OSError, json.JSONDecodeError):
            refuse("closure authority is unreadable")
        if set(authority) != {
            "schema", "requirementsSha256", "closureManifestSha256"
        } or authority["schema"] != "agentbootup.hermes-m0h-closure-authority/v1" or \
                authority["requirementsSha256"] != PINS["requirements.txt"] or \
                not re.fullmatch(r"[0-9a-f]{64}", authority["closureManifestSha256"]):
            refuse("closure authority drifted")
        before = fingerprint_private_tree(quarantine)
        artifacts_source = quarantine / "artifacts"
        for name, expected in PINS.items():
            source = artifacts_source / name
            if not source.is_file() or source.is_symlink() or digest(source) != expected:
                refuse(f"pinned artifact mismatch: {name}")
        wheelhouse_source = artifacts_source / "wheelhouse"
        wheels = sorted(wheelhouse_source.iterdir())
        if not wheels or any(not item.is_file() or item.is_symlink() for item in wheels):
            refuse("quarantine wheelhouse must contain only regular dependency wheels")
        def lock_artifacts(row: dict) -> list[dict]:
            values = list(row.get("wheels", []))
            if isinstance(row.get("sdist"), dict):
                values.append(row["sdist"])
            return values

        lock_rows = {
            normalized_name(row["name"]): {
                "version": row["version"],
                "hashes": {
                    item["hash"].removeprefix("sha256:")
                    for item in lock_artifacts(row)
                },
            }
            for row in tomllib.loads(lock.read_text())["package"]
        }
        manifest_rows = []
        for wheel in wheels:
            name, version = verify_wheel(wheel)
            wheel_hash = digest(wheel)
            locked = lock_rows.get(name)
            if not locked or locked["version"] != version or wheel_hash not in locked["hashes"]:
                refuse(f"selected wheel is not bound to uv.lock: {wheel.name}")
            manifest_rows.append({"filename": wheel.name, "name": name, "sha256": wheel_hash, "version": version})
        verify_wheel(artifacts_source / "hermes_agent-0.19.0-py3-none-any.whl")

        runtime = install / "runtime"
        runtime.mkdir(mode=PRIVATE_DIRECTORY)
        python_archive = artifacts_source / "python-3.13.13-linux-24.04-x64.tar.gz"
        with tarfile.open(python_archive, "r:gz") as archive:
            validate_tar(archive)
            archive.extractall(runtime, filter="fully_trusted")
        runtime.chmod(PRIVATE_DIRECTORY)
        tools = install / "tools"
        tools.mkdir(mode=PRIVATE_DIRECTORY)
        uv_archive = artifacts_source / "uv-x86_64-unknown-linux-gnu.tar.gz"
        with tarfile.open(uv_archive, "r:gz") as archive:
            validate_tar(archive, expected_uv=True)
            member = next(
                item for item in archive.getmembers()
                if item.isfile() and item.name == "uv-x86_64-unknown-linux-gnu/uv"
            )
            with archive.extractfile(member) as source, (tools / "uv").open("xb") as destination:
                shutil.copyfileobj(source, destination)
        (tools / "uv").chmod(0o700)

        artifacts = install / "artifacts"
        shutil.copytree(artifacts_source, artifacts)
        shutil.copy2(lock, install / "uv.lock")
        manifest = {
            "schema": "agentbootup.hermes-wheelhouse/v1",
            "requirementsSha256": PINS["requirements.txt"],
            "artifacts": manifest_rows,
        }
        manifest_path = artifacts / "closure-manifest.json"
        manifest_path.write_text(json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n")
        manifest_path.chmod(PRIVATE_FILE)
        if digest(manifest_path) != authority["closureManifestSha256"]:
            refuse("selected wheel closure does not match the pinned authority")

        runtime_python = runtime / "bin" / "python3.13"
        environment = install / "env"
        run([str(runtime_python), "-I", "-m", "venv", "--without-pip", "--copies", str(environment)], cwd=install, runtime=runtime)
        site = environment / "lib" / "python3.13" / "site-packages"
        if any(site.iterdir()):
            refuse("no-seed environment unexpectedly contains site-packages content")
        uv = tools / "uv"
        common = [
            str(uv), "pip", "install", "--python", str(environment / "bin" / "python"),
            "--offline", "--no-index", "--find-links", str(artifacts / "wheelhouse"),
        ]
        run(common + ["--require-hashes", "--only-binary", ":all:", "-r", str(artifacts / "requirements.txt")], cwd=install, runtime=runtime)
        run(common + ["--no-deps", str(artifacts / "hermes_agent-0.19.0-py3-none-any.whl")], cwd=install, runtime=runtime)
        after = fingerprint_private_tree(quarantine)
        if before != after:
            refuse("quarantine changed during offline installation")
        execution_context = {
            "imageOS": os.environ.get("ImageOS"),
            "imageVersion": os.environ.get("ImageVersion"),
            "kernel": os.uname().release,
            "machine": os.uname().machine,
            "runnerArch": os.environ.get("RUNNER_ARCH"),
            "runnerOS": os.environ.get("RUNNER_OS"),
        }
        exact_context_base = {
            "imageOS": "ubuntu24",
            "kernel": "6.17.0-1020-azure",
            "machine": "x86_64",
            "runnerArch": "X64",
            "runnerOS": "Linux",
        }
        exact_image_versions = {"20260720.247.2", "20260726.254.1"}
        exact_context_match = (
            execution_context["imageVersion"] in exact_image_versions
            and all(
                execution_context[key] == value
                for key, value in exact_context_base.items()
            )
        )
        if os.environ.get("GITHUB_ACTIONS") == "true" and not exact_context_match:
            refuse("GitHub Actions environment does not match the exact Task 1.4 lane")
        receipt = {
            "schema": "agentbootup.hermes-offline-install/v1",
            "bootstrap": "runner_system_python_validates_and_extracts_only; pinned_runtime_venv_without_pip_copies",
            "executionClass": "github_actions_exact_lane" if exact_context_match else "docker_rehearsal_nonqualifying",
            "executionContext": execution_context,
            "network": "package_index_and_network_fallback_disabled_no_egress_boundary_claimed",
            "dependencyInstallFlags": ["--require-hashes", "--offline", "--no-index", "--only-binary", ":all:"],
            "hermesInstallFlags": ["--no-deps", "--offline", "--no-index"],
            "selectedWheelCount": len(manifest_rows),
            "closureManifestSha256": digest(manifest_path),
            "pinnedInputs": {**PINS, "uv.lock": LOCK_SHA256},
            "trustBoundary": "current_uid_private_roots_no_concurrent_same_uid_mutation",
        }
        receipt_path = install / "offline-install-receipt.json"
        receipt_path.write_text(json.dumps(receipt, sort_keys=True, separators=(",", ":")) + "\n")
        receipt_path.chmod(PRIVATE_FILE)
        print(json.dumps(receipt, sort_keys=True, separators=(",", ":")))
    except BaseException:
        clean_validated_install(install, install_identity)
        raise


if __name__ == "__main__":
    main()
