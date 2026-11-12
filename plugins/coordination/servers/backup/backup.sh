#!/bin/sh
# Dump sidecar of the coordination stack (S1-BKP). POSIX sh: it runs under the busybox sh of
# the sidecar image and under dash and bash on a dev box (the tests run it on both).
#
# Modes:
#   loop   sleep until the next BACKUP_AT (default 02:00, in the container's TZ), dump, prune,
#          repeat. A failed cycle logs an ERROR line on stderr and the loop continues.
#   once   one dump (nothing else). Exit non-zero if the dump failed.
#   prune  retention only: keep the 14 newest daily dumps and 3 monthly dumps, delete the rest
#          of the a2a-<UTC timestamp>.dump files. Never touches pre-import-*.dump or any other
#          file. BACKUP_NOW (ISO-8601 UTC, e.g. 2026-11-12T02:00:00Z) overrides "now".
#
# A dump: pg_dump -Fc as the read-only role dump_ro into a temporary file in the dump
# directory, verified (pg_restore --list, then a full read with pg_restore -f /dev/null so a
# file that is cut off after its table of contents is caught too), then renamed atomically to
# a2a-<UTC timestamp>.dump. Only after that is last_ok written (temp file plus rename): one
# line, the UTC time of the dump in ISO-8601. A failed dump removes the partial file, leaves
# last_ok alone, logs an ERROR line and makes `once` exit non-zero.
#
# The password reaches pg_dump through a PGPASSFILE built in a private temp directory (tmpfs
# in the container) from the secret file at the start of a dump. It is in no argv and in no
# environment variable. Nothing in this script prints it.
#
# Environment (none of it secret):
#   PGHOST (postgres)  PGPORT (5432)  PGDATABASE (coordination)  PGUSER (dump_ro)
#   PG_DUMP_PASSWORD_FILE (/run/secrets/pg_dump_password)
#   BACKUP_DIR (/dumps)  BACKUP_STATE_DIR (/state)  BACKUP_AT (02:00 or HH:MM:SS)
#   BACKUP_TMP (/tmp)  BACKUP_NOW (prune only)
#   Test hooks: BACKUP_MAX_CYCLES (loop stops after N cycles), BACKUP_FIXED_SLEEP (seconds,
#   replaces the wait for BACKUP_AT).

set -u

KEEP_DAILY=14
KEEP_MONTHLY=3

DUMP_DIR=${BACKUP_DIR:-/dumps}
STATE_DIR=${BACKUP_STATE_DIR:-/state}
SECRET_FILE=${PG_DUMP_PASSWORD_FILE:-/run/secrets/pg_dump_password}
RUN_AT=${BACKUP_AT:-02:00}
TMP_BASE=${BACKUP_TMP:-/tmp}

PGHOST=${PGHOST:-postgres}
PGPORT=${PGPORT:-5432}
PGDATABASE=${PGDATABASE:-coordination}
PGUSER=${PGUSER:-dump_ro}
export PGHOST PGPORT PGDATABASE PGUSER
export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-10}"

WORK=""   # private temp directory holding the PGPASSFILE, set by setup_pgpass
PARTIAL="" # the dump file in progress, removed on any exit path

ts_now() { date -u +%Y%m%dT%H%M%SZ; }
iso_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

log() { printf '%s %s\n' "$(iso_now)" "$*"; }
err() { printf '%s ERROR %s\n' "$(iso_now)" "$*" >&2; }

cleanup() {
    [ -n "$PARTIAL" ] && rm -f "$PARTIAL"
    [ -n "$WORK" ] && rm -rf "$WORK"
    return 0
}

# Build $WORK/pgpass (mode 0600) from the secret file. `:` and `\` in the value are escaped as
# the pgpass format requires. The value goes through pipes and a redirect only, never argv.
setup_pgpass() {
    if [ ! -r "$SECRET_FILE" ]; then
        err "cannot read the dump_ro secret file $SECRET_FILE"
        return 1
    fi
    if [ -z "$(tr -d '\r\n' <"$SECRET_FILE")" ]; then
        err "the dump_ro secret file $SECRET_FILE is empty"
        return 1
    fi
    WORK=$(umask 077 && mktemp -d "$TMP_BASE/a2a-dump.XXXXXX") || {
        err "cannot create a temporary directory in $TMP_BASE"
        return 1
    }
    (
        umask 077
        {
            printf '%s:%s:%s:%s:' "$PGHOST" "$PGPORT" "$PGDATABASE" "$PGUSER"
            sed -e 's/\\/\\\\/g' -e 's/:/\\:/g' "$SECRET_FILE" | tr -d '\r\n'
            printf '\n'
        } >"$WORK/pgpass"
    ) || {
        err "cannot write the password file"
        return 1
    }
    chmod 0600 "$WORK/pgpass"
    PGPASSFILE="$WORK/pgpass"
    export PGPASSFILE
}

# 20261112T020000Z -> 2026-11-12T02:00:00Z
ts_to_iso() {
    printf '%s\n' "$1" | sed -e 's/^\(....\)\(..\)\(..\)T\(..\)\(..\)\(..\)Z$/\1-\2-\3T\4:\5:\6Z/'
}

write_last_ok() {
    stamp=$(ts_to_iso "$1")
    tmp="$STATE_DIR/.last_ok.$$"
    if ! (umask 022 && printf '%s\n' "$stamp" >"$tmp") || ! mv -f "$tmp" "$STATE_DIR/last_ok"; then
        rm -f "$tmp"
        err "cannot write $STATE_DIR/last_ok (the dump file is kept)"
        return 1
    fi
}

do_dump() {
    if [ ! -d "$DUMP_DIR" ] || [ ! -w "$DUMP_DIR" ]; then
        err "dump directory $DUMP_DIR is missing or not writable"
        return 1
    fi
    if [ ! -d "$STATE_DIR" ] || [ ! -w "$STATE_DIR" ]; then
        err "state directory $STATE_DIR is missing or not writable"
        return 1
    fi
    setup_pgpass || return 1

    # Partial files of a run that was killed hard: our own temp names, same directory.
    for stale in "$DUMP_DIR"/.a2a-*.dump.partial; do
        [ -f "$stale" ] && rm -f "$stale"
    done

    ts=$(ts_now)
    final="$DUMP_DIR/a2a-$ts.dump"
    PARTIAL="$DUMP_DIR/.a2a-$ts.dump.partial"
    if [ -e "$final" ]; then
        err "$final already exists; not overwriting it"
        PARTIAL=""
        return 1
    fi

    log "dump start: $PGUSER@$PGHOST/$PGDATABASE -> a2a-$ts.dump"
    if ! (umask 077 && pg_dump -Fc -w -f "$PARTIAL"); then
        err "pg_dump failed; partial file removed, last_ok not updated"
        rm -f "$PARTIAL"
        PARTIAL=""
        return 1
    fi
    if ! pg_restore --list "$PARTIAL" >/dev/null; then
        err "pg_restore --list failed on the new dump; file removed, last_ok not updated"
        rm -f "$PARTIAL"
        PARTIAL=""
        return 1
    fi
    if ! pg_restore -f /dev/null "$PARTIAL"; then
        err "pg_restore could not read the whole new dump; file removed, last_ok not updated"
        rm -f "$PARTIAL"
        PARTIAL=""
        return 1
    fi
    if ! mv "$PARTIAL" "$final"; then
        err "cannot move the verified dump to $final; last_ok not updated"
        rm -f "$PARTIAL"
        PARTIAL=""
        return 1
    fi
    PARTIAL=""
    size=$(wc -c <"$final" | tr -d ' ')
    write_last_ok "$ts" || return 1
    log "dump ok: a2a-$ts.dump ($size bytes), verified, last_ok updated"
}

# Names of the nightly dumps, one per line, oldest first. Only the exact shape
# a2a-YYYYMMDDTHHMMSSZ.dump counts: anything else (pre-import-*, a2a-foo.dump, other files,
# the sidecar's own .partial files) is not a candidate for deletion.
list_nightly() {
    for f in "$DUMP_DIR"/a2a-*.dump; do
        [ -f "$f" ] || continue
        name=${f##*/}
        case $name in
        a2a-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z.dump) printf '%s\n' "$name" ;;
        esac
    done | sort
}

do_prune() {
    now=${BACKUP_NOW:-$(iso_now)}
    case $now in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z) ;;
    *)
        err "BACKUP_NOW must look like 2026-11-12T02:00:00Z, got '$now'"
        return 2
        ;;
    esac
    if [ ! -d "$DUMP_DIR" ]; then
        err "dump directory $DUMP_DIR is missing"
        return 1
    fi

    # Keep: the newest dump of each of the KEEP_DAILY most recent UTC days that have a dump,
    # plus the first dump of each of the KEEP_MONTHLY calendar months ending with the month of
    # "now". The awk program prints the names to delete.
    victims=$(list_nightly | awk -v now="$now" -v kd="$KEEP_DAILY" -v km="$KEEP_MONTHLY" '
        BEGIN {
            y = substr(now, 1, 4) + 0; m = substr(now, 6, 2) + 0
            for (i = 0; i < km; i++) {
                keepm[sprintf("%04d%02d", y, m)] = 1
                m--; if (m == 0) { m = 12; y-- }
            }
        }
        {
            name = $0; day = substr(name, 5, 8); mon = substr(name, 5, 6)
            all[NR] = name
            if (!(day in newest)) { nd++; days[nd] = day }
            newest[day] = name
            if (!(mon in firstm)) firstm[mon] = name
        }
        END {
            for (i = nd - kd + 1; i <= nd; i++) if (i >= 1) keep[newest[days[i]]] = 1
            for (mon in firstm) if (mon in keepm) keep[firstm[mon]] = 1
            for (i = 1; i <= NR; i++) if (!(all[i] in keep)) print all[i]
        }')
    removed=0
    for name in $victims; do
        if rm -f "$DUMP_DIR/$name"; then
            removed=$((removed + 1))
        else
            err "cannot delete $DUMP_DIR/$name"
            return 1
        fi
    done
    log "prune ok: $removed old dump(s) removed (keep $KEEP_DAILY daily, $KEEP_MONTHLY monthly; now $now)"
}

# Seconds from "now" (seconds since local midnight, $1) to the next BACKUP_AT, never 0.
seconds_until_next() {
    case $RUN_AT in
    [0-9][0-9]:[0-9][0-9]) hh=${RUN_AT%%:*}; rest=${RUN_AT#*:}; mm=$rest; ss=00 ;;
    [0-9][0-9]:[0-9][0-9]:[0-9][0-9]) hh=${RUN_AT%%:*}; rest=${RUN_AT#*:}; mm=${rest%%:*}; ss=${rest#*:} ;;
    *) err "BACKUP_AT must be HH:MM or HH:MM:SS, got '$RUN_AT'"; return 1 ;;
    esac
    target=$(($(dec2 "$hh") * 3600 + $(dec2 "$mm") * 60 + $(dec2 "$ss")))
    diff=$((target - $1))
    [ "$diff" -le 0 ] && diff=$((diff + 86400))
    printf '%s\n' "$diff"
}

# Two digits with a leading zero ("08") as a decimal number (POSIX sh reads 08 as bad octal).
dec2() { printf '%s\n' $((1$1 - 100)); }

local_seconds_of_day() {
    # shellcheck disable=SC2046  # splitting the three fields is the point
    set -- $(date +'%H %M %S')
    printf '%s\n' $(($(dec2 "$1") * 3600 + $(dec2 "$2") * 60 + $(dec2 "$3")))
}

do_loop() {
    cycles=0
    trap 'log "stopping"; cleanup; exit 0' TERM INT
    while :; do
        if [ -n "${BACKUP_FIXED_SLEEP:-}" ]; then
            wait_s=$BACKUP_FIXED_SLEEP
        else
            wait_s=$(seconds_until_next "$(local_seconds_of_day)") || exit 2
        fi
        log "next dump in ${wait_s}s (at $RUN_AT, TZ=${TZ:-UTC})"
        # sleep in the background and wait, so TERM from `docker stop` is handled at once.
        sleep "$wait_s" &
        wait $!
        if ! do_dump; then
            err "dump cycle failed; the loop continues and tries again at the next scheduled time"
        elif ! do_prune; then
            err "prune failed after a good dump; the loop continues"
        fi
        cleanup
        WORK=""
        cycles=$((cycles + 1))
        if [ -n "${BACKUP_MAX_CYCLES:-}" ] && [ "$cycles" -ge "$BACKUP_MAX_CYCLES" ]; then
            return 0
        fi
    done
}

usage() {
    printf 'usage: backup.sh loop | once | prune\n' >&2
    return 2
}

main() {
    trap cleanup EXIT
    mode=${1:-loop}
    case $mode in
    loop) do_loop ;;
    once)
        do_dump
        rc=$?
        cleanup
        WORK=""
        return $rc
        ;;
    prune) do_prune ;;
    *) usage ;;
    esac
}

if [ "${BACKUP_SOURCE_ONLY:-0}" != "1" ]; then
    main "$@"
    exit $?
fi
