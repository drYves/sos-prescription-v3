#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'USAGE'
Usage:
  deploy-wordpress-artifact.sh --type theme|plugin --archive /path/artifact.zip --remote-root /remote/wp/root --ssh-host hostinger-sos [--dry-run] [--keep-tmp]

Examples:
  ./tools/deploy/deploy-wordpress-artifact.sh \
    --type theme \
    --archive /var/www/sosprescription/gp-sos-prescription-mobile.zip \
    --remote-root /home/u636254023/domains/sosprescription.fr/public_html \
    --ssh-host hostinger-sos \
    --dry-run

  ./tools/deploy/deploy-wordpress-artifact.sh \
    --type plugin \
    --archive /var/www/sosprescription/sosprescription-release.zip \
    --remote-root /home/u636254023/domains/sosprescription.fr/public_html \
    --ssh-host hostinger-sos
USAGE
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '[deploy] %s\n' "$*"
}

TYPE=""
ARCHIVE=""
REMOTE_ROOT=""
SSH_HOST=""
DRY_RUN=0
KEEP_TMP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --type)
      TYPE="${2:-}"
      shift 2
      ;;
    --archive)
      ARCHIVE="${2:-}"
      shift 2
      ;;
    --remote-root)
      REMOTE_ROOT="${2:-}"
      shift 2
      ;;
    --ssh-host)
      SSH_HOST="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --keep-tmp)
      KEEP_TMP=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "Unknown argument: $1"
      ;;
  esac
done

[[ -n "$TYPE" ]] || fail "--type is required"
[[ -n "$ARCHIVE" ]] || fail "--archive is required"
[[ -n "$REMOTE_ROOT" ]] || fail "--remote-root is required"
[[ -n "$SSH_HOST" ]] || fail "--ssh-host is required"
[[ -f "$ARCHIVE" ]] || fail "Archive not found: $ARCHIVE"

case "$TYPE" in
  theme)
    EXPECTED_ROOT="gp-sos-prescription"
    DEST_PARENT_REL="wp-content/themes"
    REQUIRED_AFTER=("style.css" "functions.php")
    ;;
  plugin)
    EXPECTED_ROOT="sos-prescription-v3"
    DEST_PARENT_REL="wp-content/plugins"
    REQUIRED_AFTER=("sosprescription.php")
    ;;
  *)
    fail "Invalid --type: $TYPE"
    ;;
esac

command -v unzip >/dev/null 2>&1 || fail "unzip is required"
command -v rsync >/dev/null 2>&1 || fail "rsync is required"
command -v ssh >/dev/null 2>&1 || fail "ssh is required"

TS="$(date -u +%Y%m%d-%H%M%S)"
TMP_DIR="$(mktemp -d "/tmp/deploy-${EXPECTED_ROOT}-${TS}.XXXXXX")"
EXTRACT_DIR="$TMP_DIR/extract"
LOCAL_ROOT="$EXTRACT_DIR/$EXPECTED_ROOT"
DEST_PARENT="$REMOTE_ROOT/$DEST_PARENT_REL"
DEST="$DEST_PARENT/$EXPECTED_ROOT"
BACKUP="$DEST_PARENT/${EXPECTED_ROOT}.backup-${TS}"

cleanup() {
  if [[ "$KEEP_TMP" != "1" ]]; then
    rm -rf "$TMP_DIR"
  else
    log "Keeping tmp dir: $TMP_DIR"
  fi
}
trap cleanup EXIT

log "START"
log "type=$TYPE"
log "archive=$ARCHIVE"
log "remote_root=$REMOTE_ROOT"
log "ssh_host=$SSH_HOST"
log "dry_run=$DRY_RUN"

log "Validating remote WordPress root"
ssh "$SSH_HOST" "test -d '$REMOTE_ROOT'" || fail "Remote root not found: $REMOTE_ROOT"
ssh "$SSH_HOST" "test -d '$DEST_PARENT'" || fail "Remote destination parent not found: $DEST_PARENT"

log "Testing archive integrity"
unzip -t "$ARCHIVE" >/dev/null

log "Checking archive root"
ROOTS="$(unzip -Z1 "$ARCHIVE" | awk -F/ 'NF {print $1}' | sort -u)"
if ! printf '%s\n' "$ROOTS" | grep -Fxq "$EXPECTED_ROOT"; then
  printf 'Archive roots found:\n%s\n' "$ROOTS" >&2
  fail "Archive does not contain expected root directory: $EXPECTED_ROOT/"
fi

UNEXPECTED_ROOTS="$(printf '%s\n' "$ROOTS" | grep -Fvx "$EXPECTED_ROOT" || true)"
if [[ -n "$UNEXPECTED_ROOTS" ]]; then
  printf 'Archive roots found:\n%s\n' "$ROOTS" >&2
  fail "Archive contains unexpected top-level entries"
fi

mkdir -p "$EXTRACT_DIR"
unzip -q "$ARCHIVE" -d "$EXTRACT_DIR"
[[ -d "$LOCAL_ROOT" ]] || fail "Extracted root not found: $LOCAL_ROOT"

case "$TYPE" in
  theme)
    [[ -f "$LOCAL_ROOT/style.css" ]] || fail "Theme archive missing gp-sos-prescription/style.css"
    [[ -f "$LOCAL_ROOT/functions.php" ]] || fail "Theme archive missing gp-sos-prescription/functions.php"
    ;;
  plugin)
    [[ -f "$LOCAL_ROOT/sosprescription.php" ]] || fail "Plugin archive missing sos-prescription-v3/sosprescription.php"
    ;;
esac

log "Remote destination: $DEST"
log "Remote backup: $BACKUP"

if [[ "$DRY_RUN" == "1" ]]; then
  log "DRY_RUN: checking backup command only, no remote changes"
  ssh "$SSH_HOST" "test -d '$DEST'" || fail "Remote destination not found: $DEST"
  rsync -az --delete --dry-run -e ssh "$LOCAL_ROOT/" "$SSH_HOST:$DEST/"
  log "DRY_RUN_OK"
  exit 0
fi

log "Creating remote backup before deploy"
ssh "$SSH_HOST" "test -d '$DEST' && cp -a '$DEST' '$BACKUP' && test -d '$BACKUP'" \
  || fail "Remote backup failed; deployment aborted"

log "Deploying with rsync --delete"
rsync -az --delete -e ssh "$LOCAL_ROOT/" "$SSH_HOST:$DEST/"

log "Validating deployed files"
for rel in "${REQUIRED_AFTER[@]}"; do
  ssh "$SSH_HOST" "test -f '$DEST/$rel'" || fail "Post-deploy validation missing file: $DEST/$rel"
done

if [[ "$TYPE" == "plugin" ]]; then
  ssh "$SSH_HOST" "test -d '$DEST/build' || true"
fi

log "DEPLOY_OK"
log "Rollback command:"
printf "ssh %q %q\n" "$SSH_HOST" "rm -rf '$DEST' && cp -a '$BACKUP' '$DEST'"
