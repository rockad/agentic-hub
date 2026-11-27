#!/bin/sh
# a2a-restic-backup.sh: second restic job, collects the a2a dump directory. USER-INSTALLED (S2-DEPLOY).
set -eu

A2A_RESTIC_REPO="${A2A_RESTIC_REPO:-}"
A2A_RESTIC_PASSWORD_FILE="${A2A_RESTIC_PASSWORD_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/a2a-coord/restic-password}"
A2A_DUMP_DIR="${A2A_DUMP_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/a2a-coord/dumps}"
A2A_RESTIC_KEEP_LAST="${A2A_RESTIC_KEEP_LAST:-3}"
A2A_RESTIC_TAG="${A2A_RESTIC_TAG:-a2a-dumps}"

[ -n "$A2A_RESTIC_REPO" ] || { echo "ERROR: A2A_RESTIC_REPO is required" >&2; exit 1; }
[ -f "$A2A_RESTIC_PASSWORD_FILE" ] || { echo "ERROR: password file $A2A_RESTIC_PASSWORD_FILE is missing or not a file" >&2; exit 1; }

# Check file permissions: expect exactly 3 octal digits where group and other digits are 0 (e.g. 600, 400, 700).
# Portable stat: Linux uses stat -c %a, BSD/macOS uses stat -f %Lp
PERMS=$(stat -c %a "$A2A_RESTIC_PASSWORD_FILE" 2>/dev/null || stat -f %Lp "$A2A_RESTIC_PASSWORD_FILE" 2>/dev/null || echo "0000")
PERMS=$(echo "$PERMS" | sed 's/^[0-7]*\(...\)$/\1/')

# Extract owner, group, and other permission digits
OWNER_PERM=$(echo "$PERMS" | cut -c1)
GROUP_PERM=$(echo "$PERMS" | cut -c2)
OTHER_PERM=$(echo "$PERMS" | cut -c3)

# Group and other permissions must be 0 (no group or other access)
case "$GROUP_PERM$OTHER_PERM" in
    *[4567]*|*[123]* )
        echo "ERROR: password file permissions $PERMS are too wide (must be 0600 or stricter)" >&2
        exit 1
        ;;
esac

[ -d "$A2A_DUMP_DIR" ] || { echo "ERROR: dump directory $A2A_DUMP_DIR is not a directory" >&2; exit 1; }
# Check that dump directory contains at least one .dump file
found_dumps=0
for f in "$A2A_DUMP_DIR"/*.dump; do
    if [ -f "$f" ]; then
        found_dumps=1
        break
    fi
done
[ "$found_dumps" -eq 1 ] || { echo "ERROR: dump directory $A2A_DUMP_DIR has no .dump files" >&2; exit 1; }

export RESTIC_REPOSITORY="$A2A_RESTIC_REPO"
export RESTIC_PASSWORD_FILE="$A2A_RESTIC_PASSWORD_FILE"

restic backup "$A2A_DUMP_DIR" --tag "$A2A_RESTIC_TAG"
restic forget --keep-last "$A2A_RESTIC_KEEP_LAST" --prune --tag "$A2A_RESTIC_TAG"
