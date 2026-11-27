"""S1-PG / S1-BKP exit tests against a real Postgres 17 container (`pg_server`):

- `a2a-coord db init-dump-role` idempotency on a fresh role/DB and an existing role/DB;
- `dump_ro` privilege bounds (LOGIN, NOSUPERUSER, `pg_read_all_data` read-only);
- password rotation rejecting the old password and accepting the new one;
- zero secret leakage in `docker compose` / `psql` / `pg_dump` argv, stdout/stderr, dump files,
  and Postgres container logs;
- end-to-end `backup.sh once` (`pg_dump -Fc` + `pg_restore --list` + `pg_restore -f /dev/null`)
  and `pg_restore --single-transaction --exit-on-error` into a scratch database with full
  row-count parity across every schema table and `CoordTaskStore.check_integrity().ok`.
"""

from __future__ import annotations

import os
import secrets
import shutil
import stat
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
import sqlalchemy as sa

from conftest import PLUGIN_DIR, run
from coordination.backup_status import dump_age_h, is_stale
from coordination.cli import main
from coordination.db_admin import DUMP_ROLE, RunResult, init_dump_role
from coordination.store.tables import api_keys, session_aliases, wakes
from coordination.store.task_store import CoordTaskStore
from service_helpers import CARD_A, CARD_B, H_A1, H_B1, local, msg, service_env, to_meta
from store_helpers import migrated_engine

SCRIPT = PLUGIN_DIR / "servers" / "backup" / "backup.sh"


def _canary(tag: str) -> str:
    # Include pgpass (`:`, `\`) and SQL (`'`, `$`) special characters alongside a random suffix.
    return f"CANARY-{tag}-'q\\b:c$d-{secrets.token_hex(8)}"


def _pg_logs(pg_server) -> str:
    proc = subprocess.run(
        ["docker", "logs", pg_server.name],
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    return proc.stdout + proc.stderr


def _psql_as_role(pg_server, database: str, user: str, password: str, sql: str) -> subprocess.CompletedProcess[str]:
    """Run `psql` inside the Postgres container over TCP with SCRAM-SHA-256 auth via PGPASSWORD env."""
    return subprocess.run(
        [
            "docker",
            "exec",
            "-i",
            "-e",
            "PGPASSWORD",
            pg_server.name,
            "psql",
            "-h",
            "127.0.0.1",
            "-U",
            user,
            "-d",
            database,
            "-X",
            "-q",
            "-v",
            "ON_ERROR_STOP=1",
            "-tA",
        ],
        input=sql,
        capture_output=True,
        text=True,
        env={**os.environ, "PGPASSWORD": password},
        check=False,
        timeout=30,
    )


def _container_runner(pg_server, database: str, *, recorded_argvs: list[list[str]] | None = None):
    """Build a `db_admin.Runner` that executes `init_dump_role`'s stdin SQL inside `pg_server`."""

    def runner(argv, stdin, _env):
        if recorded_argvs is not None:
            recorded_argvs.append(list(argv))
        proc = subprocess.run(
            [
                "docker",
                "exec",
                "-i",
                "-e",
                "PGPASSWORD",
                pg_server.name,
                "psql",
                "-h",
                "127.0.0.1",
                "-U",
                "coordination",
                "-d",
                database,
                "-X",
                "-q",
                "-v",
                "ON_ERROR_STOP=1",
            ],
            input=stdin,
            capture_output=True,
            text=True,
            env={**os.environ, "PGPASSWORD": pg_server.password},
            check=False,
            timeout=30,
        )
        return RunResult(proc.returncode, proc.stdout, proc.stderr)

    return runner


def _drop_dump_role(pg_server) -> None:
    pg_server.psql("postgres", f"DROP ROLE IF EXISTS {DUMP_ROLE}")


def _make_stack(tmp_path: Path, password: str) -> tuple[Path, Path, Path]:
    secrets_dir = tmp_path / "secrets"
    secrets_dir.mkdir(mode=0o700, exist_ok=True)
    pw_file = secrets_dir / "pg_dump_password"
    pw_file.write_text(password + "\n")
    pw_file.chmod(0o600)
    compose = tmp_path / "docker-compose.yml"
    compose.write_text("name: testproj\n")
    return secrets_dir, pw_file, compose


def _table_counts(pg_server, database: str) -> dict[str, int]:
    tables_raw = pg_server.psql(
        database,
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    )
    tables = [t for t in tables_raw.splitlines() if t]
    assert tables, f"expected migrated tables in {database}"
    counts: dict[str, int] = {}
    for tbl in tables:
        counts[tbl] = int(pg_server.psql(database, f'SELECT count(*) FROM "{tbl}"'))
    return counts


def _install_container_pg_shims(fakebin: Path, container_name: str, log_dir: Path) -> None:
    """Install host `pg_dump` and `pg_restore` shims that invoke the real Postgres 17 tools inside `pg_server`."""
    fakebin.mkdir(parents=True, exist_ok=True)
    log_dir.mkdir(parents=True, exist_ok=True)

    pg_dump_shim = fakebin / "pg_dump"
    pg_dump_shim.write_text(
        "#!/bin/sh\n"
        "set -eu\n"
        f'printf "%s\\n" "$*" >> "{log_dir}/pg_dump.argv"\n'
        f'env > "{log_dir}/pg_dump.env"\n'
        '[ -n "${PGPASSFILE:-}" ] && [ -f "$PGPASSFILE" ]\n'
        '[ "$(stat -c %a "$PGPASSFILE" 2>/dev/null || stat -f %Lp "$PGPASSFILE")" = 600 ]\n'
        "out=\n"
        'while [ $# -gt 0 ]; do [ "$1" = -f ] && out=$2; shift; done\n'
        '[ -n "$out" ]\n'
        f'docker exec -i "{container_name}" sh -c '
        '\'umask 077; t=$(mktemp); trap "rm -f \\"$t\\"" EXIT; cat > "$t"; chmod 600 "$t"; '
        'PGPASSFILE="$t" exec pg_dump -h "$1" -p "$2" -U "$3" -d "$4" -Fc -w\' '
        '_ "$PGHOST" "$PGPORT" "$PGUSER" "$PGDATABASE" < "$PGPASSFILE" > "$out"\n'
    )
    pg_dump_shim.chmod(0o755)

    pg_restore_shim = fakebin / "pg_restore"
    pg_restore_shim.write_text(
        "#!/bin/sh\n"
        "set -eu\n"
        f'printf "%s\\n" "$*" >> "{log_dir}/pg_restore.argv"\n'
        "file=\n"
        'for a; do file=$a; done\n'
        'case "$*" in\n'
        f'  *--list*) exec docker exec -i "{container_name}" pg_restore --list < "$file" ;;\n'
        f'  *) exec docker exec -i "{container_name}" pg_restore -f /dev/null < "$file" ;;\n'
        "esac\n"
    )
    pg_restore_shim.chmod(0o755)


def test_init_dump_role_idempotent_on_fresh_and_existing_db_and_rotates_password(pg_server, pg_db, tmp_path, capsys):
    db1_cfg = pg_db()
    db2_cfg = pg_db()
    db1 = db1_cfg.db_url.rsplit("/", 1)[1]
    db2 = db2_cfg.db_url.rsplit("/", 1)[1]

    async def migrate_both():
        async with migrated_engine(db1_cfg):
            pass
        async with migrated_engine(db2_cfg):
            pass

    run(migrate_both())

    old_pw = _canary("old")
    new_pw = _canary("new")
    secrets_dir, pw_file, compose = _make_stack(tmp_path, old_pw)
    argvs: list[list[str]] = []

    _drop_dump_role(pg_server)
    try:
        # 1. Fresh role creation via the CLI (`a2a-coord db init-dump-role`) against db1.
        rc = main(
            ["db", "init-dump-role", "--secrets-dir", str(secrets_dir), "--compose-file", str(compose), "-p", "p1"],
            environ={},
            runner=_container_runner(pg_server, db1, recorded_argvs=argvs),
        )
        out1 = capsys.readouterr()
        assert rc == 0 and out1.err == "" and "dump_ro: role ready" in out1.out

        # Role flags and read-only enforcement.
        role_flags = pg_server.psql(
            db1,
            "SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, "
            "pg_has_role('dump_ro', 'pg_read_all_data', 'USAGE') FROM pg_roles WHERE rolname = 'dump_ro'",
        )
        assert role_flags == "t|f|f|f|f|t"

        sel = _psql_as_role(pg_server, db1, DUMP_ROLE, old_pw, "SELECT version FROM coord_schema_version")
        assert sel.returncode == 0, sel.stderr
        ins = _psql_as_role(
            pg_server,
            db1,
            DUMP_ROLE,
            old_pw,
            "INSERT INTO cards (card_id, harness, machine, card_json) VALUES ('x@y', 'h', 'm', '{}')",
        )
        assert ins.returncode != 0 and "permission denied" in ins.stderr

        # 2. Idempotent re-run on the existing role/db1 and on a second fresh db2.
        line2 = init_dump_role(
            compose_file=compose,
            project="p1",
            secrets_dir=secrets_dir,
            environ={},
            runner=_container_runner(pg_server, db1, recorded_argvs=argvs),
        )
        line3 = init_dump_role(
            compose_file=compose,
            project="p1",
            secrets_dir=secrets_dir,
            environ={},
            runner=_container_runner(pg_server, db2, recorded_argvs=argvs),
        )
        assert line2 == line3 == out1.out.strip()
        assert _psql_as_role(pg_server, db2, DUMP_ROLE, old_pw, "SELECT count(*) FROM tasks").returncode == 0

        # 3. Password rotation: old password is rejected, new password succeeds.
        pw_file.write_text(new_pw + "\n")
        rc_rot = main(
            ["db", "init-dump-role", "--secrets-dir", str(secrets_dir), "--compose-file", str(compose), "-p", "p1"],
            environ={},
            runner=_container_runner(pg_server, db1, recorded_argvs=argvs),
        )
        out_rot = capsys.readouterr()
        assert rc_rot == 0 and out_rot.err == ""

        rejected = _psql_as_role(pg_server, db1, DUMP_ROLE, old_pw, "SELECT 1")
        assert rejected.returncode != 0
        assert "authentication failed" in rejected.stderr.lower()
        accepted = _psql_as_role(pg_server, db1, DUMP_ROLE, new_pw, "SELECT 1")
        assert accepted.returncode == 0, accepted.stderr

        # 4. Zero secret leakage in argv, CLI output, and Postgres container logs.
        flat_argvs = "\n".join(" ".join(a) for a in argvs)
        logs = _pg_logs(pg_server)
        for secret in (old_pw, new_pw):
            assert secret not in flat_argvs
            assert secret not in out1.out + out1.err + out_rot.out + out_rot.err
            assert secret not in logs
    finally:
        _drop_dump_role(pg_server)


def test_backup_once_and_pg_restore_row_count_parity_against_postgres(pg_server, pg_db, tmp_path):
    assert SCRIPT.is_file(), f"missing {SCRIPT}"
    assert shutil.which("sh") is not None

    src_cfg = pg_db()
    src_db = src_cfg.db_url.rsplit("/", 1)[1]
    dst_db = pg_server.create_database()

    async def seed_source() -> tuple[str, str]:
        async with service_env(src_cfg) as env:
            await env.add_session(H_A1)
            await env.add_session(H_B1)
            t1 = await env.service.send_message(local(CARD_B, H_B1), CARD_A, msg("backup-body-one"), metadata=to_meta(H_A1))
            await env.service.respond(local(CARD_A, H_A1), t1.id, "working", text="working-on-it")
            t2 = await env.service.send_message(local(CARD_B, H_B1), CARD_A, msg("backup-body-two"), metadata=to_meta(H_A1))

            now = env.clock.now()
            async with env.engine.begin() as conn:
                await conn.execute(
                    sa.insert(session_aliases).values(
                        handle=H_A1, alias="alias-one", card_id=CARD_A, created_at=now
                    )
                )
                await conn.execute(
                    sa.insert(wakes).values(handle=H_A1, at=now, pending_n=1, set_hash="0123456789abcdef")
                )
                await conn.execute(
                    sa.insert(api_keys).values(
                        key_id="deadbeef",
                        env="dev",
                        name="backup-test-key",
                        scope="local-harness",
                        card_id=CARD_A,
                        secret_hash="not-a-real-secret-hash",
                        created_at=now,
                        expires_at=now + timedelta(days=30),
                    )
                )
            return t1.id, t2.id

    t1_id, t2_id = run(seed_source())
    src_counts = _table_counts(pg_server, src_db)
    assert src_counts["cards"] == 3
    assert src_counts["sessions"] == 2
    assert src_counts["tasks"] == 2
    assert src_counts["task_versions"] == 2
    assert src_counts["task_index"] == 2
    assert src_counts["audit"] >= 1
    assert src_counts["wakes"] == 1
    assert src_counts["api_keys"] == 1
    assert src_counts["session_aliases"] == 1

    active_pw = _canary("dump-active")
    stale_pw = _canary("dump-stale")
    secrets_dir, pw_file, compose = _make_stack(tmp_path, active_pw)

    dirs = {k: tmp_path / k for k in ("dumps", "state", "tmp", "fakebin", "log")}
    for p in dirs.values():
        p.mkdir()
    _install_container_pg_shims(dirs["fakebin"], pg_server.name, dirs["log"])

    _drop_dump_role(pg_server)
    try:
        init_dump_role(
            compose_file=compose,
            project="p1",
            secrets_dir=secrets_dir,
            environ={},
            runner=_container_runner(pg_server, src_db),
        )

        env = {
            "PATH": f"{dirs['fakebin']}:{os.environ['PATH']}",
            "BACKUP_DIR": str(dirs["dumps"]),
            "BACKUP_STATE_DIR": str(dirs["state"]),
            "BACKUP_TMP": str(dirs["tmp"]),
            "PG_DUMP_PASSWORD_FILE": str(pw_file),
            "PGHOST": "127.0.0.1",
            "PGPORT": "5432",
            "PGDATABASE": src_db,
            "PGUSER": DUMP_ROLE,
        }
        proc = subprocess.run(
            ["sh", str(SCRIPT), "once"],
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        assert proc.returncode == 0, proc.stderr

        dumps = sorted(dirs["dumps"].iterdir())
        assert len(dumps) == 1
        dump_file = dumps[0]
        assert stat.S_IMODE(dump_file.stat().st_mode) == 0o600
        assert dump_file.read_bytes().startswith(b"PGDMP")

        # Verify `last_ok` written and readable via `backup_status`.
        last_ok = dirs["state"] / "last_ok"
        assert last_ok.is_file()
        age = dump_age_h(last_ok, datetime.now(UTC))
        assert age is not None and age < 0.1 and not is_stale(age)

        # Verify zero secret leakage in argv, env, script output, dump file, or Postgres logs.
        pg_dump_argv = (dirs["log"] / "pg_dump.argv").read_text()
        pg_dump_env = (dirs["log"] / "pg_dump.env").read_text()
        pg_restore_argv = (dirs["log"] / "pg_restore.argv").read_text()
        assert "--list" in pg_restore_argv and "/dev/null" in pg_restore_argv
        assert active_pw not in proc.stdout + proc.stderr
        assert active_pw not in pg_dump_argv + pg_dump_env + pg_restore_argv
        assert active_pw.encode() not in dump_file.read_bytes()
        assert active_pw not in _pg_logs(pg_server)

        # Restore into a brand-new database via real `pg_restore --single-transaction --exit-on-error`.
        restore_proc = subprocess.run(
            [
                "docker",
                "exec",
                "-i",
                "-e",
                "PGPASSWORD",
                pg_server.name,
                "pg_restore",
                "-h",
                "127.0.0.1",
                "-U",
                "coordination",
                "-d",
                dst_db,
                "--single-transaction",
                "--exit-on-error",
            ],
            input=dump_file.read_bytes(),
            capture_output=True,
            env={**os.environ, "PGPASSWORD": pg_server.password},
            check=False,
            timeout=60,
        )
        assert restore_proc.returncode == 0, restore_proc.stderr.decode(errors="replace")

        # Exact row-count parity across every table in the restored schema.
        dst_counts = _table_counts(pg_server, dst_db)
        assert dst_counts == src_counts

        async def verify_restored_store():
            dst_cfg = pg_server.config(dst_db)
            async with migrated_engine(dst_cfg) as engine:
                store = CoordTaskStore(engine)
                integrity = await store.check_integrity()
                got1 = await store.get(t1_id)
                got2 = await store.get(t2_id)
                return integrity, got1, got2

        integrity, got1, got2 = run(verify_restored_store())
        assert integrity.ok
        assert got1 is not None and got1.task.history[0].parts[0].text == "backup-body-one"
        assert got2 is not None and got2.task.history[0].parts[0].text == "backup-body-two"

        # Negative control: after password rotation, the stale password in backup.sh fails closed
        # and does not overwrite last_ok or leave a partial file.
        prior_last_ok = last_ok.read_text()
        pw_file.write_text(stale_pw + "\n")
        fail_proc = subprocess.run(
            ["sh", str(SCRIPT), "once"],
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        assert fail_proc.returncode != 0
        assert "ERROR" in fail_proc.stderr and "last_ok not updated" in fail_proc.stderr
        assert last_ok.read_text() == prior_last_ok
        assert sorted(dirs["dumps"].iterdir()) == [dump_file]
        assert stale_pw not in fail_proc.stdout + fail_proc.stderr
        assert stale_pw not in _pg_logs(pg_server)
    finally:
        _drop_dump_role(pg_server)
        pg_server.drop_database(dst_db)
