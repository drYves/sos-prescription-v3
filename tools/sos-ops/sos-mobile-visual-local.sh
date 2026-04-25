#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="/root/sos-prescription-v3"
QA_DIR="$REPO_ROOT/tools/mobile-visual"

usage() {
  cat <<'USAGE'
Usage:
  tools/sos-ops/sos-mobile-visual-local.sh

Runs SOS local mobile visual QA from the canonical tools/mobile-visual directory.
This wrapper does not deploy, purge cache, touch WordPress, or modify product code.
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

[ -d "$QA_DIR" ] || { printf 'ERROR: mobile visual QA directory not found: %s\n' "$QA_DIR" >&2; exit 1; }
[ -f "$QA_DIR/package.json" ] || { printf 'ERROR: package.json not found in %s\n' "$QA_DIR" >&2; exit 1; }

printf 'SOS_MOBILE_VISUAL_LOCAL_START\n'
printf 'repo=%s\n' "$REPO_ROOT"
printf 'qa_dir=%s\n' "$QA_DIR"

cd "$QA_DIR"
npm run mobile:visual:local

printf 'SOS_MOBILE_VISUAL_LOCAL_DONE\n'
