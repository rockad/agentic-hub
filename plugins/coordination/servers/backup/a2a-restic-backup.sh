#!/bin/sh
# a2a-restic-backup.sh: second restic job, collects the a2a dump directory. USER-INSTALLED (S2-DEPLOY).
set -eu

A2A_RESTIC_REPO="${A2A_RESTIC_REPO:-}"
A2A_RESTIC_PASSWORD_FILE="${A2A_RESTIC_PASSWORD_FILE:-${XDG_CONFIG_HOME:-${HOME:-/nonexistent}/.config}/a2a-coord/restic-password}"
A2A_DUMP_DIR="${A2A_DUMP_DIR:-${XDG_DATA_HOME:-${HOME:-/nonexistent}/.local/share}/a2a-coord/dumps}"
A2A_RESTIC_KEEP_LAST="${A2A_RESTIC_KEEP_LAST:-3}"
A2A_RESTIC_TAG="${A2A_RESTIC_TAG:-a2a-dumps}"

[ -n "$A2A_RESTIC_REPO" ] || { echo "ERROR: A2A_RESTIC_REPO is required" >&2; exit 1; }
case "$A2A_RESTIC_KEEP_LAST" in
    ''|*[!0-9]*|0)
        echo "ERROR: A2A_RESTIC_KEEP_LAST must be a positive integer (got ${A2A_RESTIC_KEEP_LAST:-empty})" >&2
        exit 1
        ;;
esac
[ -f "$A2A_RESTIC_PASSWORD_FILE" ] || { echo "ERROR: password file $A2A_RESTIC_PASSWORD_FILE is missing or not a file" >&2; exit 1; }

[ -r "$A2A_RESTIC_PASSWORD_FILE" ] || { echo "ERROR: password file $A2A_RESTIC_PASSWORD_FILE is not readable" >&2; exit 1; }

# Check file permissions: must be 0600 or 0400 (portable: Linux stat -c %a, BSD/macOS stat -f %Lp).
PERMS=$(stat -c '%a' "$A2A_RESTIC_PASSWORD_FILE" 2>/dev/null || stat -f '%Lp' "$A2A_RESTIC_PASSWORD_FILE" 2>/dev/null || echo "")
case "$PERMS" in
    600|0600|400|0400) ;;
    *)
        echo "ERROR: password file permissions ${PERMS:-unknown} are too wide or invalid (must be 0600 or 0400)" >&2
        exit 1
        ;;
esac

[ -d "$A2A_DUMP_DIR" ] || { echo "ERROR: dump directory $A2A_DUMP_DIR is not a directory" >&2; exit 1; }
# Check that dump directory contains at least one non-empty .dump file
found_dumps=0
for f in "$A2A_DUMP_DIR"/*.dump; do
    if [ -f "$f" ] && [ -s "$f" ]; then
        found_dumps=1
        break
    fi
done
[ "$found_dumps" -eq 1 ] || { echo "ERROR: dump directory $A2A_DUMP_DIR has no .dump files" >&2; exit 1; }

unset RESTIC_PASSWORD RESTIC_PASSWORD_COMMAND
export RESTIC_REPOSITORY="$A2A_RESTIC_REPO"
export RESTIC_PASSWORD_FILE="$A2A_RESTIC_PASSWORD_FILE"

restic backup --tag "$A2A_RESTIC_TAG" -- "$A2A_DUMP_DIR"
restic forget --keep-last "$A2A_RESTIC_KEEP_LAST" --prune --tag "$A2A_RESTIC_TAG"
