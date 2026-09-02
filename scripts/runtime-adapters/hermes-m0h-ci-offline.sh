#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 18 ]]; then
  echo "usage: hermes-m0h-ci-offline.sh REPO QUARANTINE INSTALL HERMES_HOME EVIDENCE LOCK PYTHON BUN USER_HOME RUNNER_WORKSPACE TRANSFER_ROOT FULL_ROOT QUIESCENCE_ROOT DATABASE_ROOT IMAGE_OS IMAGE_VERSION RUNNER_OS RUNNER_ARCH" >&2
  exit 64
fi

repo_root=$1
quarantine_root=$2
install_root=$3
hermes_home=$4
evidence_root=$5
lock_path=$6
python_bin=$7
bun_bin=$8
user_home=$9
runner_workspace=${10}
transfer_root=${11}
full_root=${12}
quiescence_root=${13}
database_root=${14}
image_os=${15}
image_version=${16}
runner_os=${17}
runner_arch=${18}

for value in \
  "$repo_root" "$quarantine_root" "$install_root" "$hermes_home" \
  "$evidence_root" "$lock_path" "$python_bin" "$bun_bin" "$user_home" \
  "$runner_workspace" "$transfer_root" "$full_root" "$quiescence_root" \
  "$database_root"; do
  if [[ $value != /* ]]; then
    echo "Hermes M0-H offline phase requires normalized absolute paths" >&2
    exit 64
  fi
done

export HOME=$user_home
export GITHUB_ACTIONS=true
export ImageOS=$image_os
export ImageVersion=$image_version
export RUNNER_OS=$runner_os
export RUNNER_ARCH=$runner_arch
export PATH=/usr/bin:/bin
export LANG=C
export LC_ALL=C
export TZ=UTC
export TMPDIR=$evidence_root/.tmp
mkdir -m 700 "$TMPDIR"

# A successful connection means the qualification phase is not actually
# isolated. Exit 23 is the fixed expected result for a blocked socket.
set +e
"$python_bin" -I -B - <<'PY'
import socket
try:
    socket.create_connection(("1.1.1.1", 443), timeout=1).close()
except OSError:
    raise SystemExit(23)
raise SystemExit(0)
PY
network_probe=$?
set -e
if [[ $network_probe -ne 23 ]]; then
  echo "Hermes M0-H offline phase does not have a proven no-egress namespace" >&2
  exit 1
fi

"$python_bin" "$repo_root/scripts/runtime-adapters/hermes-m0h-offline-install.py" \
  --quarantine "$quarantine_root" \
  --install-root "$install_root" \
  --lock "$lock_path" \
  --repo-root "$repo_root" \
  --workspace-root "$runner_workspace"

"$bun_bin" "$repo_root/scripts/runtime-adapters/hermes-m0h-synthetic-install.mjs" \
  --request "$evidence_root/synthetic-request.json"

LD_LIBRARY_PATH="$install_root/runtime/lib" \
  "$install_root/env/bin/python" -I -B \
  "$repo_root/scripts/runtime-adapters/hermes-m0h-profile-transfer-probe.py" \
  --request "$evidence_root/profile-transfer-request.json"

LD_LIBRARY_PATH="$install_root/runtime/lib" \
  "$install_root/env/bin/python" -I -B \
  "$repo_root/scripts/runtime-adapters/hermes-m0h-full-backup-probe.py" \
  --request "$evidence_root/full-backup-request.json"

LD_LIBRARY_PATH="$install_root/runtime/lib" \
  "$install_root/env/bin/python" -I -B \
  "$repo_root/scripts/runtime-adapters/hermes-m0h-quiescence-probe.py" \
  --request "$evidence_root/quiescence-request.json"

LD_LIBRARY_PATH="$install_root/runtime/lib" \
  "$install_root/env/bin/python" -I -B \
  "$repo_root/scripts/runtime-adapters/hermes-m0h-database-probe.py" \
  --request "$evidence_root/database-request.json"

"$bun_bin" "$repo_root/scripts/runtime-adapters/hermes-m0h-probe.mjs" \
  --request "$evidence_root/artifact-preflight-request.json"

"$bun_bin" "$repo_root/scripts/runtime-adapters/hermes-m0h-probe.mjs" \
  --request "$evidence_root/profile-list-request.json"
