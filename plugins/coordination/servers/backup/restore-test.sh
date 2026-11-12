#!/bin/sh
# Restore test for the dump sidecar (S1-BKP, SP5 D7 as the model). Run it on a dev box, with a
# stack that is up and with the dump_ro role created (`a2a-coord db init-dump-role`).
#
#   COMPOSE_PROJECT_NAME=s1bkpdev A2A_SECRETS_DIR=... A2A_DUMP_DIR=... A2A_UID=0 A2A_GID=0 \
#     sh servers/backup/restore-test.sh
#
# What it does:
#   1. creates synthetic test tables sessions, tasks, task_index and wakes, with foreign keys,
#      in a schema of their own (bkp_restore_test) in the real database, as the coordination
#      user. Test data only; the real schema arrives with S1-STORE. The schema is dropped at the
#      end, also when the test fails.
#   2. starts a writer: about ten transactions a second, each inserting a session, a task, its
#      index row and a wake, parent and child rows in one transaction.
#   3. while the writer runs, takes dump A with `docker compose --profile backup run --rm dump once`.
#   4. restores dump A with pg_restore into a SCRATCH Postgres (a throwaway container of the same
#      pinned image, no network, never the real volume) and checks: pg_restore exits 0, no row
#      violates a foreign key, the orphan-task count is 0, and the four tables hold the same
#      number of rows (every transaction wrote one row to each, so only a consistent snapshot
#      gives equal counts).
#   5. stops the writer, waits for it, records the source counts, takes dump B, restores it into
#      the scratch Postgres and checks that the restored row counts EQUAL the source counts. The
#      counts are compared after the writer has stopped; a dump taken under load is a snapshot of
#      an earlier moment and is checked for integrity (step 4), not for equality with the source.
#   6. removes the scratch container, the test schema and the two test dump files.
#
# No secret is printed. The scratch container has no password and no network: it can only be
# reached by `docker exec`, and it is removed at the end.
#
# Set KEEP=1 to keep the two dump files, WRITER_SECONDS (default 8) for the time the writer runs
# before dump A.

# shellcheck disable=SC2015,SC2016,SC2086
# ("a && pass || fail" is intended; the single-quoted command runs in the container's shell;
# "set -- $A" splits four numbers.)
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
COMPOSE_FILE=${COMPOSE_FILE:-$HERE/../../docker-compose.yml}
PROJECT=${COMPOSE_PROJECT_NAME:-}
SCHEMA=bkp_restore_test
SCRATCH="a2a-restore-scratch-$$"
WORK=$(mktemp -d)
WRITER_SECONDS=${WRITER_SECONDS:-8}
FAILED=0
WRITER_PID=""
DUMP_A=""
DUMP_B=""

if [ -z "$PROJECT" ]; then
    echo "set COMPOSE_PROJECT_NAME to the compose project of the stack to test" >&2
    exit 2
fi
if [ "$PROJECT" = "coordination" ] && [ "${A2A_RESTORE_TEST_ALLOW_DEFAULT:-0}" != "1" ]; then
    echo "refusing to write test tables into the default project 'coordination'; use a dev project name" >&2
    echo "(or set A2A_RESTORE_TEST_ALLOW_DEFAULT=1 if you are sure)" >&2
    exit 2
fi
export COMPOSE_PROJECT_NAME="$PROJECT"
DUMP_DIR=${A2A_DUMP_DIR:-${HOME}/.local/share/a2a-coord/dumps}

dc() { docker compose -f "$COMPOSE_FILE" "$@"; }

# SQL on stdin, as the coordination user, in the real database. The password is read from the
# secret file inside the container, by the shell in the container; it is in no argv.
psql_real() {
    dc exec -T postgres sh -c 'PGPASSWORD="$(cat /run/secrets/a2a_db_password)" exec psql -X -q -At -v ON_ERROR_STOP=1 -U coordination -d coordination'
}

# SQL on stdin, in the scratch container ($1 is the database).
psql_scratch() {
    docker exec -i "$SCRATCH" psql -X -q -At -v ON_ERROR_STOP=1 -U coordination -d "$1"
}

pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; FAILED=1; }
check() { # check <description> <expected> <actual>
    if [ "$2" = "$3" ]; then pass "$1 ($3)"; else fail "$1: expected $2, got $3"; fi
}

cleanup() {
    rc=$?
    if [ -n "$WRITER_PID" ]; then
        echo "UPDATE $SCHEMA.writer_ctl SET stop = true;" | psql_real >/dev/null 2>&1 || true
        sleep 1
        kill "$WRITER_PID" 2>/dev/null || true
    fi
    echo "DROP SCHEMA IF EXISTS $SCHEMA CASCADE;" | psql_real >/dev/null 2>&1 || true
    docker rm -f "$SCRATCH" >/dev/null 2>&1 || true
    if [ "${KEEP:-0}" != "1" ]; then
        [ -n "$DUMP_A" ] && rm -f "$DUMP_DIR/$DUMP_A"
        [ -n "$DUMP_B" ] && rm -f "$DUMP_DIR/$DUMP_B"
    fi
    if [ -d "$WORK" ]; then
        rm -f "$WORK"/*
        rmdir "$WORK"
    fi
    exit $rc
}
trap cleanup EXIT INT TERM

newest_dump() { # the name of the newest a2a-<UTC timestamp>.dump (the names sort by time)
    newest=""
    for f in "$DUMP_DIR"/a2a-????????T??????Z.dump; do
        [ -f "$f" ] && newest=${f##*/}
    done
    printf '%s\n' "$newest"
}

counts_real() {
    psql_real <<EOF
SELECT (SELECT count(*) FROM $SCHEMA.sessions) || ' ' || (SELECT count(*) FROM $SCHEMA.tasks) || ' ' ||
       (SELECT count(*) FROM $SCHEMA.task_index) || ' ' || (SELECT count(*) FROM $SCHEMA.wakes);
EOF
}

counts_scratch() { # counts_scratch <database>
    psql_scratch "$1" <<EOF
SELECT (SELECT count(*) FROM $SCHEMA.sessions) || ' ' || (SELECT count(*) FROM $SCHEMA.tasks) || ' ' ||
       (SELECT count(*) FROM $SCHEMA.task_index) || ' ' || (SELECT count(*) FROM $SCHEMA.wakes);
EOF
}

# Orphan tasks: a task without its index row or without its session. Plus every other
# foreign-key edge checked by a join (the FKs themselves are validated by pg_restore).
orphans_scratch() { # orphans_scratch <database>
    psql_scratch "$1" <<EOF
SELECT (SELECT count(*) FROM $SCHEMA.tasks t LEFT JOIN $SCHEMA.task_index i ON i.task_id = t.id WHERE i.task_id IS NULL)
     + (SELECT count(*) FROM $SCHEMA.tasks t LEFT JOIN $SCHEMA.sessions s ON s.id = t.session_id WHERE s.id IS NULL)
     + (SELECT count(*) FROM $SCHEMA.task_index i LEFT JOIN $SCHEMA.tasks t ON t.id = i.task_id WHERE t.id IS NULL)
     + (SELECT count(*) FROM $SCHEMA.wakes w LEFT JOIN $SCHEMA.tasks t ON t.id = w.task_id WHERE t.id IS NULL)
     + (SELECT count(*) FROM $SCHEMA.wakes w LEFT JOIN $SCHEMA.sessions s ON s.id = w.session_id WHERE s.id IS NULL);
EOF
}

fk_count_scratch() {
    psql_scratch "$1" <<EOF
SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND convalidated AND connamespace = '$SCHEMA'::regnamespace;
EOF
}

restore_into_scratch() { # restore_into_scratch <dump file name> <database>
    docker exec "$SCRATCH" createdb -U coordination "$2"
    docker cp "$DUMP_DIR/$1" "$SCRATCH:/tmp/$2.dump"
    if docker exec "$SCRATCH" pg_restore -U coordination -d "$2" --exit-on-error "/tmp/$2.dump" >"$WORK/restore_$2.log" 2>&1; then
        pass "pg_restore of $1 into scratch database $2 exited 0"
    else
        fail "pg_restore of $1 into scratch database $2 failed"
        sed -n '1,20p' "$WORK/restore_$2.log"
    fi
}

echo "== 1. synthetic tables in the real database ($PROJECT)"
psql_real <<EOF
DROP SCHEMA IF EXISTS $SCHEMA CASCADE;
CREATE SCHEMA $SCHEMA;
SET search_path = $SCHEMA;
CREATE TABLE sessions (id bigserial PRIMARY KEY, label text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE tasks (id bigserial PRIMARY KEY, session_id bigint NOT NULL REFERENCES sessions (id), body text NOT NULL);
CREATE TABLE task_index (task_id bigint PRIMARY KEY REFERENCES tasks (id), state text NOT NULL);
CREATE TABLE wakes (id bigserial PRIMARY KEY, session_id bigint NOT NULL REFERENCES sessions (id), task_id bigint NOT NULL REFERENCES tasks (id));
CREATE TABLE writer_ctl (stop boolean NOT NULL);
INSERT INTO writer_ctl VALUES (false);
DO \$\$
DECLARE s bigint; t bigint;
BEGIN
  FOR i IN 1..3000 LOOP
    INSERT INTO sessions (label) VALUES ('seed') RETURNING id INTO s;
    INSERT INTO tasks (session_id, body) VALUES (s, repeat('seed-body-', 40)) RETURNING id INTO t;
    INSERT INTO task_index (task_id, state) VALUES (t, 'SUBMITTED');
    INSERT INTO wakes (session_id, task_id) VALUES (s, t);
  END LOOP;
END \$\$;
EOF
pass "tables created and seeded: $(counts_real)"

echo "== 2. writer: parent and child rows in one transaction, about ten transactions a second"
cat >"$WORK/writer.sql" <<EOF
SET search_path = $SCHEMA;
DO \$\$
DECLARE s bigint; t bigint; v_stop boolean;
BEGIN
  LOOP
    SELECT w.stop INTO v_stop FROM writer_ctl w;
    EXIT WHEN v_stop;
    INSERT INTO sessions (label) VALUES ('writer') RETURNING id INTO s;
    INSERT INTO tasks (session_id, body) VALUES (s, repeat('writer-body-', 40)) RETURNING id INTO t;
    INSERT INTO task_index (task_id, state) VALUES (t, 'SUBMITTED');
    INSERT INTO wakes (session_id, task_id) VALUES (s, t);
    COMMIT;
    PERFORM pg_sleep(0.1);
  END LOOP;
END \$\$;
EOF
psql_real <"$WORK/writer.sql" >"$WORK/writer.log" 2>&1 &
WRITER_PID=$!
sleep "$WRITER_SECONDS"
kill -0 "$WRITER_PID" 2>/dev/null && pass "writer is running" || fail "writer died early: $(cat "$WORK/writer.log")"

echo "== 3. dump A under load"
C0=$(counts_real | cut -d' ' -f2)
dc --profile backup run --rm dump once >"$WORK/dump_a.log" 2>&1 && pass "dump once (A) exited 0" || { fail "dump once (A) failed"; cat "$WORK/dump_a.log"; }
C1=$(counts_real | cut -d' ' -f2)
DUMP_A=$(newest_dump)
[ -n "$DUMP_A" ] && pass "dump A is $DUMP_A" || fail "no dump file written"
[ "$C1" -gt "$C0" ] && pass "writer kept inserting during the dump (tasks $C0 before, $C1 after)" || fail "tasks did not grow during the dump ($C0, $C1)"

echo "== 4. restore dump A (taken under load) into a scratch Postgres"
IMAGE=$(dc config --format json | jq -r '.services.postgres.image')
# Trust authentication is acceptable only here: no network, no published port, no volume of the
# stack, removed at the end of the run. The stack itself has no trust anywhere.
docker run -d --name "$SCRATCH" --network none -e POSTGRES_USER=coordination -e POSTGRES_DB=coordination \
    -e POSTGRES_HOST_AUTH_METHOD=trust "$IMAGE" >/dev/null
tries=0
until [ "$(docker logs "$SCRATCH" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ]; do
    tries=$((tries + 1))
    [ "$tries" -lt 60 ] || { fail "scratch Postgres did not come up"; exit 1; }
    sleep 1
done
pass "scratch Postgres is up ($IMAGE)"
restore_into_scratch "$DUMP_A" restore_a
A=$(counts_scratch restore_a)
set -- $A
if [ "$1" = "$2" ] && [ "$2" = "$3" ] && [ "$3" = "$4" ]; then pass "dump A is one consistent snapshot: sessions, tasks, task_index and wakes all hold $1 rows"; else fail "dump A counts differ between tables: $A"; fi
if [ "$2" -ge "$C0" ] && [ "$2" -le "$C1" ]; then pass "dump A holds $2 tasks, between $C0 and $C1 (taken while the writer ran)"; else fail "dump A holds $2 tasks, outside $C0..$C1"; fi
check "orphan tasks in the restore of dump A" 0 "$(orphans_scratch restore_a)"
check "validated foreign keys in the restore of dump A" 4 "$(fk_count_scratch restore_a)"

echo "== 5. stop the writer, compare the restore of dump B with the source"
echo "UPDATE $SCHEMA.writer_ctl SET stop = true;" | psql_real
if wait "$WRITER_PID"; then pass "writer stopped cleanly"; else fail "writer exited non-zero: $(cat "$WORK/writer.log")"; fi
WRITER_PID=""
grep -q ERROR "$WORK/writer.log" && fail "writer logged an error" || pass "writer log has no error"
SRC=$(counts_real)
dc --profile backup run --rm dump once >"$WORK/dump_b.log" 2>&1 && pass "dump once (B) exited 0" || { fail "dump once (B) failed"; cat "$WORK/dump_b.log"; }
DUMP_B=$(newest_dump)
[ "$DUMP_B" != "$DUMP_A" ] && pass "dump B is $DUMP_B" || fail "dump B was not written"
restore_into_scratch "$DUMP_B" restore_b
check "restored row counts (sessions tasks task_index wakes) equal the source counts after the writer stopped" "$SRC" "$(counts_scratch restore_b)"
check "orphan tasks in the restore of dump B" 0 "$(orphans_scratch restore_b)"
check "validated foreign keys in the restore of dump B" 4 "$(fk_count_scratch restore_b)"

echo "== 6. clean up"
if [ "$FAILED" = 0 ]; then echo "RESULT: PASS"; else echo "RESULT: FAIL"; exit 1; fi
