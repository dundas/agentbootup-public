#!/usr/bin/env bash
set -euo pipefail

# Compatibility wrapper for legacy fleet skill sync flows.
# Broad and targeted rollout semantics now live in `agentbootup bundle rollout`.

if [[ $# -eq 0 ]]; then
  echo "Usage: scripts/sync-skills.sh <selector> [bundle rollout args...]"
  echo
  echo "Examples:"
  echo "  scripts/sync-skills.sh all --all --cwd ~/dev_env/decisive_redux"
  echo "  scripts/sync-skills.sh brain-message-inbox,skill-promoter --project bootup,landing"
  exit 1
fi

selector="$1"
shift

exec bun ./bootup.mjs bundle rollout "$selector" "$@"
