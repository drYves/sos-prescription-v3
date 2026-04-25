#!/usr/bin/env bash
set -euo pipefail

umask 077

OUT_DIR="/var/www/sosprescription/audits/01_CODEX_OPS/codex_reviews"
MODE=""
TARGET=""

usage() {
  cat <<'USAGE'
Usage:
  tools/review/codex-review-gate.sh --uncommitted
  tools/review/codex-review-gate.sh --base <ref>
  tools/review/codex-review-gate.sh --commit <sha>
  tools/review/codex-review-gate.sh --help

Runs a non-mutating Codex review gate and stores stdout/stderr in:
  /var/www/sosprescription/audits/01_CODEX_OPS/codex_reviews/

The gate is advisory. It does not replace lint, builds, QA, dry-runs, or runtime validation.
USAGE
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_git_repo() {
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not inside a git repository"
}

require_codex_review() {
  command -v codex >/dev/null 2>&1 || die "CODEX_REVIEW_UNAVAILABLE: codex command not found"
  codex review --help >/dev/null 2>&1 || die "CODEX_REVIEW_UNAVAILABLE: codex review is not available"
}

slugify() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9._-]+/-/g; s/^-+//; s/-+$//' | cut -c1-80
}

allocate_report() {
  base_name="$1"
  counter=0

  while [ "$counter" -lt 100 ]; do
    if [ "$counter" -eq 0 ]; then
      candidate="$OUT_DIR/${base_name}.txt"
    else
      candidate="$OUT_DIR/${base_name}_${counter}.txt"
    fi

    if ( set -C; : > "$candidate" ) 2>/dev/null; then
      chmod 600 "$candidate" 2>/dev/null || true
      printf '%s\n' "$candidate"
      return 0
    fi

    counter=$((counter + 1))
  done

  die "could not allocate a unique report path in $OUT_DIR"
}

parse_args() {
  if [ "$#" -eq 0 ]; then
    usage
    exit 2
  fi

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --help|-h)
        usage
        exit 0
        ;;
      --uncommitted)
        [ -z "$MODE" ] || die "choose only one mode"
        MODE="uncommitted"
        shift
        ;;
      --base)
        [ -z "$MODE" ] || die "choose only one mode"
        [ "${2:-}" != "" ] || die "--base requires a ref"
        MODE="base"
        TARGET="$2"
        shift 2
        ;;
      --commit)
        [ -z "$MODE" ] || die "choose only one mode"
        [ "${2:-}" != "" ] || die "--commit requires a sha"
        MODE="commit"
        TARGET="$2"
        shift 2
        ;;
      *)
        die "unknown argument: $1"
        ;;
    esac
  done

  [ -n "$MODE" ] || die "no mode selected"
}

main() {
  parse_args "$@"
  require_git_repo
  require_codex_review

  mkdir -p "$OUT_DIR"
  chmod 700 "$OUT_DIR" 2>/dev/null || true

  if [ "$MODE" = "uncommitted" ] && [ -z "$(git status --short)" ]; then
    printf 'NO_UNCOMMITTED_DIFF\n'
    exit 0
  fi

  if [ "$MODE" = "commit" ]; then
    git rev-parse --verify "$TARGET^{commit}" >/dev/null 2>&1 || die "commit not found: $TARGET"
  fi

  if [ "$MODE" = "base" ]; then
    git rev-parse --verify "$TARGET" >/dev/null 2>&1 || die "base ref not found: $TARGET"
  fi

  local_ts="$(date -u '+%Y%m%d_%H%M%S')"
  if [ -n "$TARGET" ]; then
    suffix="${MODE}_$(slugify "$TARGET")"
  else
    suffix="$MODE"
  fi
  report="$(allocate_report "codex_review_${local_ts}_$$_${suffix}")"

  printf 'CODEX_REVIEW_START mode=%s target=%s\n' "$MODE" "${TARGET:-}" | tee -a "$report"
  printf 'working_tree=%s\n' "$(pwd)" | tee -a "$report"
  printf 'timestamp_utc=%s\n\n' "$local_ts" | tee -a "$report"

  review_status=0
  case "$MODE" in
    uncommitted)
      codex review --uncommitted --title "SOS pre-commit review: uncommitted" >>"$report" 2>&1 || review_status=$?
      ;;
    base)
      codex review --base "$TARGET" --title "SOS branch review: $TARGET" >>"$report" 2>&1 || review_status=$?
      ;;
    commit)
      codex review --commit "$TARGET" --title "SOS commit review: $TARGET" >>"$report" 2>&1 || review_status=$?
      ;;
    *)
      die "unsupported mode: $MODE"
      ;;
  esac

  printf 'CODEX_REVIEW_EXIT_STATUS=%s\n' "$review_status" | tee -a "$report"
  printf '\nCODEX_REVIEW_REPORT=%s\n' "$report" | tee -a "$report"
  exit "$review_status"
}

main "$@"
