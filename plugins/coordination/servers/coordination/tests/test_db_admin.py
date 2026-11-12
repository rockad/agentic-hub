import os
from pathlib import Path

import pytest

from coordination import db_admin
from coordination.cli import main
from coordination.db_admin import (
    InitDumpRoleError,
    RunResult,
    build_sql,
    compose_argv,
    init_dump_role,
    redact,
    sql_literal,
)

# Throwaway canaries. They contain a quote, a backslash and a dollar sign on purpose.
OLD = "CANARY-DUMP-old'q\\b$d"
NEW = "CANARY-DUMP-new$$'';--"


class FakeRunner:
    """Records every call. Behaves like a database that keeps the last password it was given."""

    def __init__(self, returncode=0, stderr=""):
        self.calls = []
        self.returncode, self.stderr = returncode, stderr

    def __call__(self, argv, stdin, env):
        self.calls.append((list(argv), stdin, dict(env)))
        return RunResult(self.returncode, "", self.stderr)


@pytest.fixture
def stack(tmp_path):
    secrets = tmp_path / "secrets"
    secrets.mkdir(mode=0o700)
    pw = secrets / "pg_dump_password"
    pw.write_text(OLD)
    pw.chmod(0o600)
    compose = tmp_path / "docker-compose.yml"
    compose.write_text("name: x\n")
    return secrets, pw, compose


def run(stack, runner, **kw):
    secrets, _, compose = stack
    return init_dump_role(compose_file=compose, project="p", secrets_dir=secrets, environ={}, runner=runner, **kw)


@pytest.mark.parametrize(
    "value,literal",
    [
        ("plain", "'plain'"),
        ("a'b", "'a''b'"),
        ("a\\b", "'a\\b'"),  # a backslash is literal with standard_conforming_strings on
        ("$$ x $$", "'$$ x $$'"),
        ("''", "''''''"),
        ("a\nb", "'a\nb'"),
    ],
)
def test_sql_literal(value, literal):
    assert sql_literal(value) == literal


def test_sql_payload_shape_and_order():
    sql = build_sql(OLD)
    lines = sql.splitlines()
    assert lines[0] == "SET log_statement = 'none';"
    assert "SET log_min_error_statement = 'panic';" in lines
    assert "SET standard_conforming_strings = on;" in lines
    # the SETs come before the statement that carries the password
    assert sql.index("standard_conforming_strings") < sql.index("PASSWORD")
    assert "CREATE ROLE dump_ro LOGIN" in sql and "IF NOT EXISTS" in sql
    assert f"PASSWORD {sql_literal(OLD)};" in sql
    assert sql.rstrip().endswith("GRANT pg_read_all_data TO dump_ro;")
    assert sql.index("CREATE ROLE") < sql.index("ALTER ROLE") < sql.index("GRANT")
    assert "NOSUPERUSER" in sql and "SUPERUSER" not in sql.replace("NOSUPERUSER", "")


def test_argv_has_no_secret_and_stdin_carries_it(stack):
    r = FakeRunner()
    line = run(stack, r)
    argv, stdin, env = r.calls[0]
    assert argv[:7] == ["docker", "compose", "-f", str(stack[2]), "-p", "p", "exec"]
    assert "-T" in argv and "postgres" in argv and "psql" in argv[-1] and "ON_ERROR_STOP=1" in argv[-1]
    assert all(OLD not in a for a in argv)
    assert "CANARY" not in " ".join(argv)
    assert sql_literal(OLD) in stdin
    # the server password reaches psql from the mounted secret, inside the container
    assert "/run/secrets/a2a_db_password" in argv[-1]
    assert "CANARY" not in line and "pg_dump_password" in line
    assert env["A2A_SECRETS_DIR"] == str(stack[0])


def test_repeatable_runs_are_identical_and_succeed(stack):
    r = FakeRunner()
    first = run(stack, r)
    second = run(stack, r)
    third = run(stack, r)
    assert first == second == third
    assert len(r.calls) == 3
    assert r.calls[0][:2] == r.calls[1][:2] == r.calls[2][:2]


def test_rotation_sends_only_the_new_password(stack):
    r = FakeRunner()
    run(stack, r)
    stack[1].write_text(NEW + "\n")  # a trailing newline is not part of the password
    run(stack, r)
    assert sql_literal(OLD) in r.calls[0][1] and sql_literal(OLD) not in r.calls[1][1]
    assert f"PASSWORD {sql_literal(NEW)};" in r.calls[1][1]


def test_failure_message_never_contains_the_password(stack):
    stderr = (
        'psql: error: ERROR:  syntax error\n'
        f"LINE 6: ...PASSWORD '{OLD.replace(chr(39), chr(39) * 2)}';\n"
        "                  ^\n"
        f"DETAIL: password {OLD} rejected\n"
    )
    r = FakeRunner(returncode=1, stderr=stderr)
    with pytest.raises(InitDumpRoleError) as e:
        run(stack, r)
    msg = str(e.value)
    assert "CANARY" not in msg and OLD not in msg
    assert "exit 1" in msg and "ERROR:  syntax error" in msg and "***" in msg


def test_redact_drops_statement_echo_lines():
    out = redact("ERROR: x\nLINE 1: ALTER ROLE ... 'CANARY-par\n   ^\n", "CANARY-partial-secret")
    assert "CANARY" not in out and out == "ERROR: x"


def test_missing_empty_and_nul_secret(stack):
    secrets, pw, compose = stack
    pw.write_text("")
    with pytest.raises(InitDumpRoleError, match="empty"):
        run(stack, FakeRunner())
    pw.write_bytes(b"ab\x00cd")
    with pytest.raises(InitDumpRoleError, match="NUL"):
        run(stack, FakeRunner())
    pw.unlink()
    with pytest.raises(InitDumpRoleError, match="cannot read"):
        run(stack, FakeRunner())


def test_runner_not_called_when_secret_unusable(stack):
    stack[1].write_text("")
    r = FakeRunner()
    with pytest.raises(InitDumpRoleError):
        run(stack, r)
    assert r.calls == []


def test_missing_compose_file(stack):
    secrets, _, compose = stack
    compose.unlink()
    with pytest.raises(InitDumpRoleError, match="compose file not found"):
        run(stack, FakeRunner())


def test_wide_mode_warns_without_the_secret(stack):
    stack[1].chmod(0o644)
    warnings = []
    run(stack, FakeRunner(), warn=warnings.append)
    assert len(warnings) == 1 and "0644" in warnings[0] and "CANARY" not in warnings[0]
    warnings.clear()
    stack[1].chmod(0o600)
    run(stack, FakeRunner(), warn=warnings.append)
    assert warnings == []


def test_defaults_flag_then_env_then_fallback(tmp_path):
    h = Path.home()
    assert db_admin.default_secrets_dir({}) == h / ".config" / "a2a-coord" / "secrets"
    assert db_admin.default_secrets_dir({"A2A_SECRETS_DIR": "/e"}) == Path("/e")
    assert db_admin.default_secrets_dir({"A2A_SECRETS_DIR": "/e"}, "/f") == Path("/f")
    assert db_admin.default_project({}) == "coordination"
    assert db_admin.default_project({"COMPOSE_PROJECT_NAME": "c"}) == "c"
    assert db_admin.default_project({"COMPOSE_PROJECT_NAME": "c", "A2A_COMPOSE_PROJECT": "a"}) == "a"
    assert db_admin.default_project({"A2A_COMPOSE_PROJECT": "a"}, "f") == "f"
    assert db_admin.default_compose_file({"A2A_COMPOSE_FILE": "/x.yml"}) == Path("/x.yml")
    assert db_admin.default_compose_file({"A2A_COMPOSE_FILE": "/x.yml"}, "/y.yml") == Path("/y.yml")
    assert db_admin.default_compose_file({}).name == "docker-compose.yml"


def test_compose_argv_is_plain_data():
    argv = compose_argv(Path("/c.yml"), "proj")
    assert argv[0:4] == ["docker", "compose", "-f", "/c.yml"]
    assert argv[-3:-1] == ["sh", "-c"]


# --- through the CLI ---------------------------------------------------------------------


def test_cli_success_prints_one_line_without_secret(stack, capsys):
    secrets, _, compose = stack
    r = FakeRunner()
    rc = main(
        ["db", "init-dump-role", "--secrets-dir", str(secrets), "--compose-file", str(compose), "-p", "zz"],
        environ={},
        runner=r,
    )
    out = capsys.readouterr()
    assert rc == 0
    assert out.out.startswith("dump_ro:") and "CANARY" not in out.out + out.err
    assert r.calls[0][0][4:6] == ["-p", "zz"]


def test_cli_reads_dirs_from_environment(stack, capsys):
    secrets, _, compose = stack
    r = FakeRunner()
    env = {"A2A_SECRETS_DIR": str(secrets), "A2A_COMPOSE_FILE": str(compose), "A2A_COMPOSE_PROJECT": "envproj"}
    assert main(["db", "init-dump-role"], environ=env, runner=r) == 0
    assert r.calls[0][0][5] == "envproj"


def test_cli_failure_returns_one_and_stays_quiet_about_the_secret(stack, capsys):
    secrets, _, compose = stack
    r = FakeRunner(returncode=1, stderr=f"boom {OLD}")
    rc = main(["db", "init-dump-role", "--secrets-dir", str(secrets), "--compose-file", str(compose)], environ={}, runner=r)
    out = capsys.readouterr()
    assert rc == 1 and "CANARY" not in out.out + out.err and "a2a-coord:" in out.err


def test_cli_db_without_subcommand_is_a_usage_error(capsys):
    with pytest.raises(SystemExit) as e:
        main(["db"])
    assert e.value.code == 2


def test_environment_is_not_modified(stack):
    before = dict(os.environ)
    run(stack, FakeRunner())
    assert dict(os.environ) == before
