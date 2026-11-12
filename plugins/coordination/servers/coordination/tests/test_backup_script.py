"""The dump sidecar script (servers/backup/backup.sh, S1-BKP): retention with a fake clock, the
dump and verify path with fake pg tools, the loop. No Postgres and no Docker needed.

The script has to behave the same under the container's busybox sh, so each test runs under every
shell found on the box (sh, bash, busybox sh). `A2A_BACKUP_IMAGE` (the built sidecar image) adds a
run of the retention test inside the image itself.
"""

import os
import re
import shutil
import stat
import subprocess
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents  # tests, servers/coordination, servers, plugin root
SCRIPT = (_ROOT[2] if len(_ROOT) > 2 else Path("/nonexistent")) / "backup" / "backup.sh"
pytestmark = pytest.mark.skipif(not SCRIPT.is_file(), reason="backup.sh is outside the build context")

SHELLS = [
    argv
    for argv in (["sh"], ["bash"], ["busybox", "sh"])
    if shutil.which(argv[0])
]
CANARY = "c4n4ry" + "0123456789abcdef" * 2

NOW = "2026-11-12T03:00:00Z"


def ids(shell):
    return "-".join(shell)


@pytest.fixture(params=SHELLS, ids=ids)
def shell(request):
    return request.param


def stamp(d: datetime) -> str:
    return d.strftime("a2a-%Y%m%dT%H%M%SZ.dump")


def run(shell, mode, env, **kw):
    full = {"PATH": os.environ["PATH"], **env}
    return subprocess.run(
        [*shell, str(SCRIPT), *([mode] if mode else [])],
        env=full, capture_output=True, text=True, timeout=60, **kw,
    )  # fmt: skip


# ---------------------------------------------------------------------------------------------
# retention
# ---------------------------------------------------------------------------------------------


def expected_survivors(names, now: datetime):
    """An independent implementation of the rule, with datetime instead of awk."""
    stamps = sorted((datetime.strptime(n, "a2a-%Y%m%dT%H%M%SZ.dump"), n) for n in names)
    newest_per_day = {}
    first_per_month = {}
    for t, n in stamps:
        newest_per_day[t.date()] = n
        first_per_month.setdefault((t.year, t.month), n)
    keep = set(list(newest_per_day.values())[-14:])
    months = []
    y, m = now.year, now.month
    for _ in range(3):
        months.append((y, m))
        y, m = (y, m - 1) if m > 1 else (y - 1, 12)
    keep |= {first_per_month[k] for k in months if k in first_per_month}
    return keep


def make_files(d: Path, names):
    for n in names:
        (d / n).write_bytes(b"x")


FOREIGN = [
    "pre-import-run42.dump", "pre-import-20260801T000000Z.dump", "notes.txt",
    "a2a-foo.dump", "a2a-20260801T020000Z.dump.bak", ".a2a-20261112T020000Z.dump.partial",
    "A2A-20260801T020000Z.dump", "last_ok",
]  # fmt: skip


def synthetic(days=95, end=datetime(2026, 11, 12, 2, 0, tzinfo=UTC)):
    out = []
    for i in range(days):
        day = end - timedelta(days=i)
        out.append(stamp(day))  # the nightly dump
        out.append(stamp(day.replace(hour=2, minute=0) - timedelta(hours=1 if i % 2 else 0, minutes=5)))  # an earlier one
    return sorted(set(out))


@pytest.mark.parametrize("scenario", ["dense", "sparse"])
def test_prune_keeps_14_daily_and_3_monthly_and_nothing_else_is_touched(shell, tmp_path, scenario):
    if scenario == "dense":
        names = synthetic()
    else:  # a dump every third day only: the 14 most recent days WITH a dump are kept
        names = [n for i, n in enumerate(synthetic(150)) if (i // 2) % 3 == 0]
    make_files(tmp_path, names + FOREIGN)
    now = datetime(2026, 11, 12, 3, 0, tzinfo=UTC)
    want = expected_survivors(names, now)

    r = run(shell, "prune", {"BACKUP_DIR": str(tmp_path), "BACKUP_NOW": NOW})
    assert r.returncode == 0, r.stderr

    left = {p.name for p in tmp_path.iterdir()}
    assert left - set(FOREIGN) == want
    assert set(FOREIGN) <= left  # pre-import, foreign and partial files are untouched
    assert len(names) > 60 and len(want) in (16, 17)  # 14 daily + 3 monthly, minus an overlap
    if scenario == "dense":
        assert len(want) == 17  # 14 daily + 3 monthly, no overlap (a month's first dump is not the newest of its day)
        assert len([n for n in want if n.endswith("T020000Z.dump") and n[4:12] >= "20261030"]) == 14  # Oct 30 .. Nov 12, newest of each day
        assert {"a2a-20261101T005500Z.dump", "a2a-20261001T015500Z.dump", "a2a-20260901T015500Z.dump"} <= want
        assert not any(n.startswith("a2a-202608") for n in want)  # August is outside the 3-month window


def test_prune_exact_names_dense(shell, tmp_path):
    """Hand-written expectation, not derived from the rule's code."""
    names = [stamp(datetime(2026, 11, 12, 2, 0, tzinfo=UTC) - timedelta(days=i)) for i in range(95)]
    make_files(tmp_path, names)
    r = run(shell, "prune", {"BACKUP_DIR": str(tmp_path), "BACKUP_NOW": NOW})
    assert r.returncode == 0, r.stderr
    left = sorted(p.name for p in tmp_path.iterdir())
    daily = [f"a2a-202611{d:02d}T020000Z.dump" for d in range(1, 13)] + [
        "a2a-20261031T020000Z.dump",
        "a2a-20261030T020000Z.dump",
    ]
    monthly = ["a2a-20261001T020000Z.dump", "a2a-20260901T020000Z.dump"]  # Nov 1 is already a daily
    assert left == sorted(daily + monthly)
    assert len(left) == 16


def test_prune_never_deletes_the_newest_dump_and_is_idempotent(shell, tmp_path):
    names = synthetic(40)
    make_files(tmp_path, names)
    env = {"BACKUP_DIR": str(tmp_path), "BACKUP_NOW": NOW}
    assert run(shell, "prune", env).returncode == 0
    first = sorted(p.name for p in tmp_path.iterdir())
    assert names[-1] in first
    assert run(shell, "prune", env).returncode == 0
    assert sorted(p.name for p in tmp_path.iterdir()) == first


def test_prune_with_year_boundary(shell, tmp_path):
    names = [stamp(datetime(2027, 1, 20, 2, 0, tzinfo=UTC) - timedelta(days=i)) for i in range(60)]
    make_files(tmp_path, names)
    r = run(shell, "prune", {"BACKUP_DIR": str(tmp_path), "BACKUP_NOW": "2027-01-20T03:00:00Z"})
    assert r.returncode == 0, r.stderr
    left = {p.name for p in tmp_path.iterdir()}
    assert left == expected_survivors(names, datetime(2027, 1, 20, 3, tzinfo=UTC))
    # the first dump of Jan, Dec and Nov (the series starts on Nov 22)
    assert {"a2a-20270101T020000Z.dump", "a2a-20261201T020000Z.dump", "a2a-20261122T020000Z.dump"} <= left


def test_prune_empty_or_only_foreign_dir(shell, tmp_path):
    make_files(tmp_path, ["pre-import-x.dump", "other.dump"])
    r = run(shell, "prune", {"BACKUP_DIR": str(tmp_path), "BACKUP_NOW": NOW})
    assert r.returncode == 0
    assert sorted(p.name for p in tmp_path.iterdir()) == ["other.dump", "pre-import-x.dump"]


def test_prune_rejects_a_bad_clock_and_a_missing_dir(shell, tmp_path):
    assert run(shell, "prune", {"BACKUP_DIR": str(tmp_path), "BACKUP_NOW": "yesterday"}).returncode == 2
    assert run(shell, "prune", {"BACKUP_DIR": str(tmp_path / "none"), "BACKUP_NOW": NOW}).returncode == 1


@pytest.mark.skipif(not os.environ.get("A2A_BACKUP_IMAGE"), reason="set A2A_BACKUP_IMAGE to the built sidecar image")
def test_prune_inside_the_image(tmp_path):
    names = [stamp(datetime(2026, 11, 12, 2, 0, tzinfo=UTC) - timedelta(days=i)) for i in range(95)]
    make_files(tmp_path, names + FOREIGN)
    tmp_path.chmod(0o777)
    for p in tmp_path.iterdir():
        p.chmod(0o666)
    r = subprocess.run(
        ["docker", "run", "--rm", "--user", "0:0", "-v", f"{tmp_path}:/dumps", "-e", f"BACKUP_NOW={NOW}",
         os.environ["A2A_BACKUP_IMAGE"], "prune"],
        capture_output=True, text=True, timeout=120,
    )  # fmt: skip
    assert r.returncode == 0, r.stderr
    left = {p.name for p in tmp_path.iterdir()}
    assert left - set(FOREIGN) == expected_survivors(names, datetime(2026, 11, 12, 3, tzinfo=UTC))
    assert set(FOREIGN) <= left


# ---------------------------------------------------------------------------------------------
# the dump path, with fake pg_dump and pg_restore
# ---------------------------------------------------------------------------------------------

FAKE_PG_DUMP = """#!/bin/sh
# fake pg_dump: records how it was called, behaves as FAKE_MODE says
echo "$*" >>"$FAKE_LOG/argv"
env >"$FAKE_LOG/env"
[ -n "$PGPASSFILE" ] && [ -f "$PGPASSFILE" ] || { echo "no PGPASSFILE" >&2; exit 9; }
[ "$(stat -c %a "$PGPASSFILE" 2>/dev/null || stat -f %Lp "$PGPASSFILE")" = 600 ] || { echo "pgpass mode" >&2; exit 9; }
[ "$(cat "$PGPASSFILE")" = "$PGHOST:$PGPORT:$PGDATABASE:$PGUSER:$(cat "$FAKE_LOG/expect")" ] || { echo "pgpass line wrong" >&2; exit 9; }
out=
while [ $# -gt 0 ]; do [ "$1" = -f ] && out=$2; shift; done
if [ -f "$FAKE_LOG/fail_once" ]; then rm -f "$FAKE_LOG/fail_once"; echo "pg_dump: error: connection failed" >&2; exit 1; fi
case "$FAKE_MODE" in
dump_fail) echo "pg_dump: error: connection to server failed" >&2; printf 'PGDMP-half' >"$out"; exit 1 ;;
*) printf 'PGDMP-fake-dump-body' >"$out" ;;
esac
"""

FAKE_PG_RESTORE = """#!/bin/sh
# fake pg_restore: --list or -f /dev/null, failing as FAKE_MODE says
file=
for a; do file=$a; done
case "$*" in
*--list*) [ "$FAKE_MODE" = list_fail ] && { echo "pg_restore: error: unexpected end of file" >&2; exit 1; } ;;
*) [ "$FAKE_MODE" = read_fail ] && { echo "pg_restore: error: could not read from input file" >&2; exit 1; } ;;
esac
grep -q PGDMP "$file" || { echo "pg_restore: error: not a dump" >&2; exit 1; }
exit 0
"""


@pytest.fixture
def box(tmp_path):
    """Directories, secret, fake tools and the base environment for the dump tests."""
    d = {k: tmp_path / k for k in ("dumps", "state", "tmp", "fakebin", "log")}
    for p in d.values():
        p.mkdir()
    secret = tmp_path / "pg_dump_password"
    secret.write_text(CANARY + "\n")
    secret.chmod(0o600)
    for name, body in (("pg_dump", FAKE_PG_DUMP), ("pg_restore", FAKE_PG_RESTORE)):
        f = d["fakebin"] / name
        f.write_text(body)
        f.chmod(0o755)
    env = {
        "PATH": f"{d['fakebin']}:{os.environ['PATH']}",
        "BACKUP_DIR": str(d["dumps"]), "BACKUP_STATE_DIR": str(d["state"]), "BACKUP_TMP": str(d["tmp"]),
        "PG_DUMP_PASSWORD_FILE": str(secret), "FAKE_LOG": str(d["log"]),
        "PGHOST": "postgres", "PGUSER": "dump_ro", "PGDATABASE": "coordination",
    }  # fmt: skip
    (d["log"] / "expect").write_text(CANARY + "\n")  # the pgpass password field the fake pg_dump expects
    return d, env, secret


def dump_files(box_dirs):
    return sorted(p.name for p in box_dirs["dumps"].iterdir())


def test_good_dump(shell, box):
    d, env, _ = box
    r = run(shell, "once", env)
    assert r.returncode == 0, r.stderr
    files = dump_files(d)
    assert len(files) == 1 and re.fullmatch(r"a2a-\d{8}T\d{6}Z\.dump", files[0])
    assert stat.S_IMODE((d["dumps"] / files[0]).stat().st_mode) == 0o600
    ts = datetime.strptime(files[0], "a2a-%Y%m%dT%H%M%SZ.dump")
    last_ok = (d["state"] / "last_ok").read_text()
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n", last_ok)
    assert datetime.strptime(last_ok.strip(), "%Y-%m-%dT%H:%M:%SZ") == ts
    assert list(d["state"].iterdir()) == [d["state"] / "last_ok"]  # no temp file left
    assert list(d["tmp"].iterdir()) == []  # PGPASSFILE directory removed
    assert abs((datetime.now(UTC).replace(tzinfo=None) - ts).total_seconds()) < 120


def test_the_password_is_in_no_argv_no_env_no_output(shell, box):
    d, env, _ = box
    r = run(shell, "once", env)
    assert r.returncode == 0, r.stderr
    assert CANARY not in r.stdout + r.stderr
    assert CANARY not in (d["log"] / "argv").read_text()
    assert CANARY not in (d["log"] / "env").read_text()
    assert "-Fc" in (d["log"] / "argv").read_text()  # custom format
    for p in d["dumps"].iterdir():
        assert CANARY.encode() not in p.read_bytes()


def test_special_characters_in_the_password_are_escaped_for_pgpass(shell, box):
    d, env, secret = box
    secret.write_text("a:b\\c:d\n")
    (d["log"] / "expect").write_text("a\\:b\\\\c\\:d\n")  # the pgpass escaping of  a:b\c:d
    r = run(shell, "once", env)
    assert r.returncode == 0, r.stderr


@pytest.mark.parametrize("mode", ["dump_fail", "list_fail", "read_fail"])
def test_failed_dump_keeps_last_ok_leaves_no_file_and_exits_non_zero(shell, box, mode):
    d, env, _ = box
    (d["state"] / "last_ok").write_text("2026-11-10T02:00:00Z\n")
    r = run(shell, "once", {**env, "FAKE_MODE": mode})
    assert r.returncode != 0
    assert "ERROR" in r.stderr and "last_ok not updated" in r.stderr
    assert dump_files(d) == []  # no partial file, no final file
    assert (d["state"] / "last_ok").read_text() == "2026-11-10T02:00:00Z\n"
    assert CANARY not in r.stdout + r.stderr
    assert list(d["tmp"].iterdir()) == []


def test_failed_first_dump_does_not_create_last_ok(shell, box):
    d, env, _ = box
    r = run(shell, "once", {**env, "FAKE_MODE": "list_fail"})
    assert r.returncode != 0
    assert not (d["state"] / "last_ok").exists()


def test_a_failure_does_not_remove_earlier_dumps(shell, box):
    d, env, _ = box
    (d["dumps"] / "a2a-20261110T020000Z.dump").write_bytes(b"PGDMP")
    run(shell, "once", {**env, "FAKE_MODE": "dump_fail"})
    assert dump_files(d) == ["a2a-20261110T020000Z.dump"]


def test_missing_or_empty_secret_is_an_error_without_a_dump(shell, box):
    d, env, secret = box
    secret.write_text("")
    r = run(shell, "once", env)
    assert r.returncode != 0 and "ERROR" in r.stderr and dump_files(d) == []
    r = run(shell, "once", {**env, "PG_DUMP_PASSWORD_FILE": str(secret) + ".missing"})
    assert r.returncode != 0 and "ERROR" in r.stderr and dump_files(d) == []


def test_missing_state_or_dump_dir_is_an_error(shell, box):
    d, env, _ = box
    assert run(shell, "once", {**env, "BACKUP_STATE_DIR": str(d["state"] / "x")}).returncode != 0
    assert run(shell, "once", {**env, "BACKUP_DIR": str(d["dumps"] / "x")}).returncode != 0


def test_stale_partial_files_of_a_killed_run_are_removed_before_the_next_dump(shell, box):
    d, env, _ = box
    (d["dumps"] / ".a2a-20260101T020000Z.dump.partial").write_bytes(b"x" * 10)
    (d["dumps"] / "pre-import-r1.dump").write_bytes(b"x")
    assert run(shell, "once", env).returncode == 0
    names = dump_files(d)
    assert "pre-import-r1.dump" in names and not any(n.endswith(".partial") for n in names)


def test_once_never_prunes(shell, box):
    d, env, _ = box
    old = [stamp(datetime(2026, 1, 1, 2, tzinfo=UTC) + timedelta(days=i)) for i in range(30)]
    make_files(d["dumps"], old)
    assert run(shell, "once", env).returncode == 0
    assert set(old) <= set(dump_files(d))


# ---------------------------------------------------------------------------------------------
# the loop
# ---------------------------------------------------------------------------------------------


def test_loop_logs_an_error_and_continues(shell, box):
    d, env, _ = box
    (d["log"] / "fail_once").write_text("")
    r = run(shell, "loop", {**env, "BACKUP_MAX_CYCLES": "2", "BACKUP_FIXED_SLEEP": "0", "BACKUP_NOW": NOW})
    assert r.returncode == 0, r.stderr
    assert r.stderr.count("ERROR") >= 2  # the pg_dump failure and the "cycle failed, loop continues" line
    assert "the loop continues" in r.stderr
    assert len([n for n in dump_files(d) if n.startswith("a2a-")]) == 1  # the second cycle worked
    assert (d["state"] / "last_ok").is_file()
    assert CANARY not in r.stdout + r.stderr


def test_loop_prunes_after_a_good_dump(shell, box):
    d, env, _ = box
    old = [stamp(datetime(2026, 1, 1, 2, tzinfo=UTC) + timedelta(days=i)) for i in range(40)] + ["pre-import-r1.dump"]
    make_files(d["dumps"], old)
    r = run(shell, "loop", {**env, "BACKUP_MAX_CYCLES": "1", "BACKUP_FIXED_SLEEP": "0"})
    assert r.returncode == 0, r.stderr
    names = dump_files(d)
    assert "pre-import-r1.dump" in names
    assert len([n for n in names if n.startswith("a2a-")]) < 41


def test_loop_does_not_prune_after_a_failed_dump(shell, box):
    d, env, _ = box
    old = [stamp(datetime(2026, 1, 1, 2, tzinfo=UTC) + timedelta(days=i)) for i in range(40)]
    make_files(d["dumps"], old)
    r = run(shell, "loop", {**env, "FAKE_MODE": "dump_fail", "BACKUP_MAX_CYCLES": "1", "BACKUP_FIXED_SLEEP": "0"})
    assert r.returncode == 0
    assert dump_files(d) == sorted(old)


@pytest.mark.parametrize(
    "run_at,now_s,want",
    [
        ("02:00", 0, 7200),
        ("02:00", 3600, 3600),
        ("02:00", 7199, 1),
        ("02:00", 7200, 86400),  # exactly at the time: tomorrow, never 0
        ("02:00", 7201, 86399),
        ("02:00", 86399, 7201),
        ("08:09:08", 0, 8 * 3600 + 9 * 60 + 8),  # leading zeros are not octal
        ("09:00", 0, 9 * 3600),
        ("00:00", 1, 86399),
    ],
)
def test_seconds_until_next_run(shell, run_at, now_s, want):
    r = subprocess.run(
        [*shell, "-c", f'. "{SCRIPT}"; seconds_until_next {now_s}'],
        env={"PATH": os.environ["PATH"], "BACKUP_SOURCE_ONLY": "1", "BACKUP_AT": run_at},
        capture_output=True, text=True, timeout=30,
    )  # fmt: skip
    assert r.stdout.strip() == str(want), r.stderr


def test_bad_backup_at_and_bad_mode(shell, box):
    d, env, _ = box
    r = run(shell, "loop", {**env, "BACKUP_AT": "2am", "BACKUP_MAX_CYCLES": "1"})
    assert r.returncode == 2 and "BACKUP_AT" in r.stderr
    assert run(shell, "frobnicate", env).returncode == 2


def test_script_is_executable_posix_sh():
    assert SCRIPT.stat().st_mode & 0o111
    assert SCRIPT.read_text().startswith("#!/bin/sh\n")
    if shutil.which("shellcheck"):
        r = subprocess.run(["shellcheck", "-s", "sh", str(SCRIPT)], capture_output=True, text=True)
        assert r.returncode == 0, r.stdout
