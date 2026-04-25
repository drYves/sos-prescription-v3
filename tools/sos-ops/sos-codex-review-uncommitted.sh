#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="/root/sos-prescription-v3"
GATE="$REPO_ROOT/tools/review/codex-review-gate.sh"

usage() {
  cat <<'USAGE'
Usage:
  tools/sos-ops/sos-codex-review-uncommitted.sh

Runs the canonical SOS Codex review gate on staged, unstaged, and untracked changes.
The gate is advisory and does not replace lint, build, QA, dry-run, or real-device validation.
USAGE
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

if [ "$#" -ne 0 ]; then
  usage >&2
  exit 2
fi

[ -x "$GATE" ] || { printf 'ERROR: codex review gate not executable: %s\n' "$GATE" >&2; exit 1; }

printf 'SOS_CODEX_REVIEW_UNCOMMITTED_START\n'
printf 'repo=%s\n' "$REPO_ROOT"
printf 'gate=%s\n' "$GATE"

cd "$REPO_ROOT"
"$GATE" --uncommitted

printf 'SOS_CODEX_REVIEW_UNCOMMITTED_DONE\n'
