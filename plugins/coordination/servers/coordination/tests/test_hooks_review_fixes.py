"""S1-CLAUDE, follow-up fixes after the reviews of PR #94 (WS0a): `bin/a2a-listen`, `bin/a2a-register`
and `bin/a2a-pending` under dash against the stub HTTP server. No Docker needed. Most tests are written
to fail against the scripts of PR #94 and pass after the fix; a few guard behaviour that was already
right (the six concurrent listeners, a Stop that keeps its marker, the /proc path, the 410 retry for
a Stop without a marker) and are named as such.

- 1  a number with a leading zero keeps the default (dash reads 08 and 09 as bad octal);
- 2  only the two documented paths may exit 2 (the INTENDED2 guard turns a shell error into exit 0);
- 3  `410 unregistered` for Stop or UserPromptSubmit with the marker present is final at once;
- 4  a zombie owner is detected without /proc by `ps -o stat=`;
- 5  a SessionStart removes the session's own marker;
- 6  a count of `0` or with a leading zero is not a count (listener: server error; pending: nothing);
- 7  the marker is created exclusively: of six listeners failing together one tells the notice;
- 8  `a2a-register` does nothing when CLAUDE_CODE_SESSION_ATTENDED is 0;
- 9  `a2a-register end` writes its marker only in the user's own state directory, never through a symlink;
- 10 `a2a-pending` never lets a shell error reach stderr.
"""

from __future__ import annotations

import json
import re
import signal
import subprocess
import time

import pytest
from hook_helpers import (
    CARD,
    DASH,
    SID,
    Reply,
    fake_tool,
    hook_env,  # noqa: F401  (fixture)
    hook_json,
    kill_quietly,
    listen_reply,
    path_with,
    plugin_file,
    run_script,
    session_reply,
    start_script,
    stub,  # noqa: F401  (fixture)
    wait_for,
)

PENDING_JSON = '{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "[a2a] %s pending. Call a2a_inbox."}}'


@pytest.fixture
def listen():
    return plugin_file("bin/a2a-listen")


@pytest.fixture
def register():
    return plugin_file("bin/a2a-register")


@pytest.fixture
def pending():
    return plugin_file("bin/a2a-pending")


def wake_text(n: int) -> str:
    return f"[a2a] {n} pending. Call a2a_inbox.\n"


def stopped_text(code: int) -> str:
    return f"[a2a] wake listener stopped: the server answered {code}. Check the coordination server and the API key.\n"


def stop_input() -> str:
    return hook_json("Stop")


def log_lines(hook_env) -> list[str]:
    path = hook_env.state / "listen.log"
    return path.read_text().splitlines() if path.exists() else []


def scratch_parent() -> subprocess.Popen:
    return subprocess.Popen(["sleep", "600"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


# ============================== 1. a number with a leading zero keeps the default ====================


def num_of(listen, value: str, default: str, lo: str, hi: str) -> str:
    """Run the script's own num() under dash."""
    text = listen.read_text()
    match = re.search(r"^num\(\) \{.*?^\}\n", text, re.M | re.S)
    assert match, "num() not found in a2a-listen"
    r = subprocess.run(
        [DASH, "-c", f'{match.group(0)}\nnum "$1" "$2" "$3" "$4"', "x", value, default, lo, hi],
        capture_output=True,
        text=True,
        check=False,
    )
    assert r.returncode == 0 and r.stderr == ""
    return r.stdout


@pytest.mark.parametrize(
    "value,expected",
    [("08", "60"), ("09", "60"), ("010", "60"), ("00", "60"), ("01", "60"), ("0", "60"), ("7", "7"), ("3600", "3600"), ("3601", "60"), ("", "60"), ("x", "60")],
)
def test_num_takes_only_digits_without_a_leading_zero(listen, value, expected):
    assert num_of(listen, value, "60", "1", "3600") == expected


def test_num_zero_itself_still_follows_the_min_max_rule(listen):
    assert num_of(listen, "0", "15", "0", "3600") == "0", "zero is inside [0, 3600]"
    assert num_of(listen, "0", "15", "1", "3600") == "15", "zero is outside [1, 3600]"
    assert num_of(listen, "00", "15", "0", "3600") == "15", "00 has a leading zero"


def test_a_poll_interval_of_08_is_the_default_and_the_listener_backs_off_normally(listen, stub, hook_env):
    """A2A_POLL_S=08 used to end the listener with an unintended exit 2 in the first back-off wait."""
    stub.script("/wake/listen", listen_reply(503), listen_reply(200, "1"))
    r = run_script(listen, stdin=stop_input(), env=hook_env(stub.url, A2A_POLL_S="08"), timeout=30)
    assert r.returncode == 2 and r.stderr == wake_text(1), "the real wake, not an unintended exit 2"
    assert len(stub.requests("/wake/listen")) == 2


def test_a_round_of_099_seconds_is_the_default_900(listen, stub, hook_env):
    stub.script("/wake/listen", listen_reply(200, "1"))
    r = run_script(listen, stdin=stop_input(), env=hook_env(stub.url, A2A_ROUND_S="099"), timeout=30)
    assert r.returncode == 2 and r.stderr == wake_text(1)
    (req,) = stub.requests("/wake/listen")
    assert req.headers["x-coord-wait"] == "900"


def test_a_backoff_cap_of_010_is_the_default_60(listen, stub, hook_env):
    """With the cap read as 10 a Retry-After of 12 was cut to 10; with the default 60 it is honoured."""
    stub.script("/wake/listen", listen_reply(503, "", **{"Retry-After": "12"}))
    proc = start_script(listen, stdin=stop_input(), env=hook_env(stub.url, A2A_BACKOFF_MAX_S="010"))
    try:
        wait_for(lambda: any("backing off" in line for line in log_lines(hook_env)), 8, "the first back-off")
        (line,) = [x for x in log_lines(hook_env) if "backing off" in x]
        assert line.endswith("backing off 12s"), line
    finally:
        proc.send_signal(signal.SIGTERM)
        proc.communicate(timeout=10)
        kill_quietly(proc)


# ============================== 2. only the two documented paths may exit 2 ==========================


def test_a_shell_error_is_a_silent_exit_0_never_an_unintended_exit_2(listen, stub, hook_env):
    """A `date` that prints `1 +` makes `$(( $(date +%s) - t0 ))` a syntax error, which kills dash with
    status 2 and would wake the session with an empty message."""
    fake = fake_tool(hook_env.tmp / "fakebin", "date", "echo '1 +'\n")
    stub.script("/wake/listen", listen_reply(200, "3"))
    r = run_script(listen, stdin=stop_input(), env=hook_env(stub.url, PATH=path_with(fake.parent)))
    assert r.returncode == 0 and r.stderr == "" and r.stdout == ""
    assert any("unexpected exit 2" in line for line in log_lines(hook_env))


def test_the_intended_exit_2_paths_still_exit_2_with_a_stray_intended2_in_the_environment(listen, stub, hook_env):
    stub.script("/wake/listen", listen_reply(401))
    r = run_script(listen, stdin=stop_input(), env=hook_env(stub.url, INTENDED2="0"))
    assert r.returncode == 2 and r.stderr == stopped_text(401)
    stub.script("/wake/listen", listen_reply(200, "2"))
    r = run_script(listen, stdin=hook_json("UserPromptSubmit"), env=hook_env(stub.url, INTENDED2="1"))
    assert r.returncode == 2 and r.stderr == wake_text(2)


def test_a_stray_intended2_in_the_environment_does_not_let_a_shell_error_exit_2(listen, stub, hook_env):
    fake = fake_tool(hook_env.tmp / "fakebin", "date", "echo '1 +'\n")
    stub.script("/wake/listen", listen_reply(200, "3"))
    r = run_script(listen, stdin=stop_input(), env=hook_env(stub.url, PATH=path_with(fake.parent), INTENDED2="1"))
    assert r.returncode == 0 and r.stderr == ""


# ============================== 3. 410 unregistered with the marker present is final =================


@pytest.mark.parametrize("event", ["Stop", "UserPromptSubmit"])
def test_410_unregistered_with_the_marker_present_is_final_at_once_for_stop_and_prompt(listen, stub, hook_env, event):
    hook_env.state.mkdir(mode=0o700, parents=True, exist_ok=True)
    (hook_env.state / f"notice-{SID}").write_text("")
    stub.script("/wake/listen", listen_reply(410, "", **{"X-Coord-Reason": "unregistered"}))
    t0 = time.monotonic()
    r = run_script(listen, stdin=hook_json(event), env=hook_env(stub.url))
    assert r.returncode == 0 and r.stderr == "" and r.stdout == ""
    assert len(stub.requests("/wake/listen")) == 1
    assert time.monotonic() - t0 < 3, "no retry pause"


def test_410_unregistered_for_a_stop_without_the_marker_is_still_retried(listen, stub, hook_env):
    unreg = listen_reply(410, "", **{"X-Coord-Reason": "unregistered"})
    stub.script("/wake/listen", unreg, unreg, listen_reply(200, "1"))
    r = run_script(listen, stdin=stop_input(), env=hook_env(stub.url))
    assert r.returncode == 2 and r.stderr == wake_text(1)
    assert len(stub.requests("/wake/listen")) == 3


def test_410_unregistered_at_session_start_is_retried_even_when_a_marker_was_there(listen, stub, hook_env):
    hook_env.state.mkdir(mode=0o700, parents=True, exist_ok=True)
    (hook_env.state / f"notice-{SID}").write_text("")
    unreg = listen_reply(410, "", **{"X-Coord-Reason": "unregistered"})
    stub.script("/wake/listen", unreg, unreg, listen_reply(200, "1"))
    r = run_script(listen, stdin=hook_json("SessionStart", source="resume"), env=hook_env(stub.url))
    assert r.returncode == 2 and r.stderr == wake_text(1)
    assert len(stub.requests("/wake/listen")) == 3


# ============================== 4. a zombie owner without /proc ======================================


def ps_fake(hook_env, flag, calls):
    """A `ps` that answers `S` until `flag` exists and `Z` after, and records its arguments."""
    return fake_tool(
        hook_env.tmp / "fakebin",
        "ps",
        f'echo "$@" >> "{calls}"\nif [ -e "{flag}" ]; then echo " Z+ "; else echo " Ss"; fi\n',
    )


def test_a_zombie_owner_is_gone_without_proc_by_the_ps_state(listen, stub, hook_env):
    stub.script("/wake/listen", Reply(408, "", delay=60.0))
    stub.script("/sessions/end", Reply(200, "{}"))
    flag, calls = hook_env.tmp / "zombie", hook_env.tmp / "ps-calls"
    fake = ps_fake(hook_env, flag, calls)
    owner = scratch_parent()
    env = hook_env(stub.url, A2A_ROUND_S="900", A2A_OWNER_PID=str(owner.pid), A2A_PROC_DIR="/nonexistent", PATH=path_with(fake.parent))
    proc = start_script(listen, stdin=stop_input(), env=env)
    try:
        wait_for(lambda: stub.requests("/wake/listen"), 10, "the listener to park")
        time.sleep(1.5)
        assert proc.poll() is None, "a live owner (ps says Ss) keeps the listener"
        flag.write_text("")  # from now on ps says Z+: the owner is a zombie
        out, err = proc.communicate(timeout=10)
    finally:
        kill_quietly(proc)
        kill_quietly(owner)
    assert proc.returncode == 0 and out == "" and err == ""
    (end,) = stub.requests("/sessions/end")
    assert json.loads(end.body) == {"card": CARD, "harness_session_id": SID}
    assert f"-o stat= -p {owner.pid}" in calls.read_text()


def test_an_empty_ps_answer_without_proc_counts_as_gone(listen, stub, hook_env):
    stub.script("/wake/listen", Reply(408, "", delay=60.0))
    stub.script("/sessions/end", Reply(200, "{}"))
    flag = hook_env.tmp / "empty"
    fake = fake_tool(hook_env.tmp / "fakebin", "ps", f'if [ -e "{flag}" ]; then :; else echo S; fi\n')
    owner = scratch_parent()
    env = hook_env(stub.url, A2A_ROUND_S="900", A2A_OWNER_PID=str(owner.pid), A2A_PROC_DIR="/nonexistent", PATH=path_with(fake.parent))
    proc = start_script(listen, stdin=stop_input(), env=env)
    try:
        wait_for(lambda: stub.requests("/wake/listen"), 10, "the listener to park")
        flag.write_text("")
        out, err = proc.communicate(timeout=10)
    finally:
        kill_quietly(proc)
        kill_quietly(owner)
    assert proc.returncode == 0 and out == "" and err == ""
    assert len(stub.requests("/sessions/end")) == 1


def test_the_proc_path_is_unchanged_when_proc_exists(listen, stub, hook_env):
    """With /proc readable the fake `ps` (which would say Z) is never consulted."""
    stub.script("/wake/listen", Reply(408, "", delay=60.0))
    fake = fake_tool(hook_env.tmp / "fakebin", "ps", "echo Z\n")
    owner = scratch_parent()
    env = hook_env(stub.url, A2A_ROUND_S="900", A2A_OWNER_PID=str(owner.pid), PATH=path_with(fake.parent))
    proc = start_script(listen, stdin=stop_input(), env=env)
    try:
        wait_for(lambda: stub.requests("/wake/listen"), 10, "the listener to park")
        time.sleep(2.5)
        assert proc.poll() is None
    finally:
        proc.send_signal(signal.SIGTERM)
        proc.communicate(timeout=10)
        kill_quietly(proc)
        kill_quietly(owner)


# ============================== 5. SessionStart removes the session's own marker =====================


def test_a_session_start_removes_a_marker_an_earlier_session_end_left_so_a_401_is_told_once(listen, stub, hook_env):
    hook_env.state.mkdir(mode=0o700, parents=True, exist_ok=True)
    marker = hook_env.state / f"notice-{SID}"
    marker.write_text("")
    stub.script("/wake/listen", listen_reply(401))
    first = run_script(listen, stdin=hook_json("SessionStart", source="resume"), env=hook_env(stub.url))
    assert first.returncode == 2 and first.stderr == stopped_text(401)
    assert marker.exists(), "the notice wrote its marker again"
    second = run_script(listen, stdin=stop_input(), env=hook_env(stub.url))
    assert second.returncode == 0 and second.stderr == "", "told once"


def test_a_stop_keeps_the_marker_it_finds(listen, stub, hook_env):
    hook_env.state.mkdir(mode=0o700, parents=True, exist_ok=True)
    marker = hook_env.state / f"notice-{SID}"
    marker.write_text("")
    stub.script("/wake/listen", listen_reply(401))
    r = run_script(listen, stdin=stop_input(), env=hook_env(stub.url))
    assert r.returncode == 0 and r.stderr == "" and marker.exists()


# ============================== 6. a count of 0 or with a leading zero ===============================


@pytest.mark.parametrize("body", ["0", "00", "007", "01", "0999"])
def test_a_200_with_a_zero_or_a_leading_zero_count_never_wakes_the_listener(listen, stub, hook_env, body):
    stub.script("/wake/listen", listen_reply(200, body))
    proc = start_script(listen, stdin=stop_input(), env=hook_env(stub.url, A2A_ROUND_S="1"))
    try:
        wait_for(lambda: len(stub.requests("/wake/listen")) >= 2, 8, "a second round after a back-off")
        assert proc.poll() is None, "a bad 200 must not end the listener"
    finally:
        proc.send_signal(signal.SIGTERM)
        out, err = proc.communicate(timeout=10)
    assert proc.returncode == 0 and err == "" and out == ""
    assert any("not a count" in line for line in log_lines(hook_env))


@pytest.mark.parametrize("n", ["0", "00", "007", "01", "0999"])
def test_pending_prints_nothing_for_a_zero_or_a_leading_zero_count(pending, stub, hook_env, n):
    stub.script("/wake/pending", Reply(200, PENDING_JSON % n))
    r = run_script(pending, [], stdin=hook_json("UserPromptSubmit"), env=hook_env(stub.url))
    assert r.returncode == 0 and r.stdout == "" and r.stderr == ""
    assert len(stub.requests("/wake/pending")) == 1


@pytest.mark.parametrize("n", ["1", "10", "9999"])
def test_pending_and_the_listener_still_take_a_valid_count(listen, pending, stub, hook_env, n):
    stub.script("/wake/pending", Reply(200, PENDING_JSON % n))
    r = run_script(pending, [], stdin=hook_json("UserPromptSubmit"), env=hook_env(stub.url))
    assert r.stdout == PENDING_JSON % n + "\n"
    stub.script("/wake/listen", listen_reply(200, n))
    w = run_script(listen, stdin=stop_input(), env=hook_env(stub.url))
    assert w.returncode == 2 and w.stderr == wake_text(int(n))


# ============================== 7. exclusive marker creation under concurrency =======================


def test_six_listeners_failing_together_give_one_notice(listen, stub, hook_env):
    """The marker is created with `set -C`: of six listeners of one session that all see a 401 at once,
    exactly one writes it and exits 2 with the notice; the five others leave silently."""
    stub.script("/wake/listen", listen_reply(401))
    env = hook_env(stub.url)
    procs = [start_script(listen, stdin=stop_input(), env=env) for _ in range(6)]
    results = []
    try:
        for p in procs:
            out, err = p.communicate(timeout=20)
            results.append((p.returncode, out, err))
    finally:
        for p in procs:
            kill_quietly(p)
    told = [r for r in results if r[0] == 2]
    silent = [r for r in results if r[0] == 0]
    assert len(told) == 1 and len(silent) == 5, results
    assert told[0][1] == "" and told[0][2] == stopped_text(401)
    assert all(r[1] == "" and r[2] == "" for r in silent)
    assert (hook_env.state / f"notice-{SID}").exists()


# ============================== 8. a2a-register and attended=0 =======================================


@pytest.mark.parametrize("mode", ["start", "end"])
def test_register_does_nothing_when_the_session_is_unattended(register, stub, hook_env, mode):
    stub.script("/sessions", session_reply())
    stub.script("/sessions/end", Reply(200, "{}"))
    env = hook_env(stub.url, CLAUDE_CODE_SESSION_ATTENDED="0")
    r = run_script(register, [mode], stdin=hook_json("SessionStart", session_title="agents-52"), env=env)
    assert r.returncode == 0 and r.stdout == "" and r.stderr == ""
    assert stub.requests() == []
    assert not hook_env.state.exists(), "no file or directory is made either"


@pytest.mark.parametrize("mode", ["start", "end"])
def test_attended_0_is_checked_before_the_key_file_is_read(register, stub, hook_env, mode):
    env = hook_env(stub.url, CLAUDE_CODE_SESSION_ATTENDED="0", A2A_KEY_FILE="/nonexistent/key")
    r = run_script(register, [mode], stdin=hook_json("SessionStart"), env=env)
    assert r.returncode == 0 and r.stdout == "" and r.stderr == "" and stub.requests() == []


@pytest.mark.parametrize("attended", ["1", None])
def test_register_behaves_as_before_when_attended_is_1_or_unset(register, stub, hook_env, attended):
    stub.script("/sessions", session_reply())
    stub.script("/sessions/end", Reply(200, "{}"))
    env = hook_env(stub.url)
    if attended is None:
        del env["CLAUDE_CODE_SESSION_ATTENDED"]
    else:
        env["CLAUDE_CODE_SESSION_ATTENDED"] = attended
    start = run_script(register, ["start"], stdin=hook_json("SessionStart", session_title="agents-52"), env=env)
    assert start.returncode == 0 and "Your session handle is" in start.stdout
    end = run_script(register, ["end"], stdin=hook_json("SessionEnd"), env=env)
    assert end.returncode == 0 and end.stdout == ""
    assert len(stub.requests("/sessions")) == 1 and len(stub.requests("/sessions/end")) == 1


# ============================== 9. a2a-register end: an own state directory, no symlink ==============


def test_end_does_not_write_through_a_planted_symlink(register, stub, hook_env):
    stub.script("/sessions/end", Reply(200, "{}"))
    hook_env.state.mkdir(mode=0o700, parents=True, exist_ok=True)
    target = hook_env.tmp / "victim-file"
    (hook_env.state / f"notice-{SID}").symlink_to(target)  # dangling
    r = run_script(register, ["end"], stdin=hook_json("SessionEnd"), env=hook_env(stub.url))
    assert r.returncode == 0 and r.stdout == "" and r.stderr == ""
    assert not target.exists(), "the marker was created through the symlink"
    assert len(stub.requests("/sessions/end")) == 1, "the end is still posted"


def test_end_does_not_truncate_the_file_a_symlink_points_to(register, stub, hook_env):
    stub.script("/sessions/end", Reply(200, "{}"))
    hook_env.state.mkdir(mode=0o700, parents=True, exist_ok=True)
    target = hook_env.tmp / "precious"
    target.write_text("keep me")
    (hook_env.state / f"notice-{SID}").symlink_to(target)
    run_script(register, ["end"], stdin=hook_json("SessionEnd"), env=hook_env(stub.url))
    assert target.read_text() == "keep me"


def test_end_leaves_an_existing_marker_alone_and_still_makes_a_new_one(register, stub, hook_env):
    stub.script("/sessions/end", Reply(200, "{}"))
    env = hook_env(stub.url)
    for _ in range(2):  # the second end finds the marker of the first
        r = run_script(register, ["end"], stdin=hook_json("SessionEnd"), env=env)
        assert r.returncode == 0 and r.stderr == ""
    assert (hook_env.state / f"notice-{SID}").is_file()


def test_end_writes_no_marker_when_the_state_directory_is_not_the_users_own(register, stub, hook_env):
    """The check is `find -user $(id -u)`; a `find` that finds nothing stands in for a directory that
    belongs to somebody else (the test cannot chown)."""
    stub.script("/sessions/end", Reply(200, "{}"))
    fake = fake_tool(hook_env.tmp / "fakebin", "find", "exit 0\n")
    r = run_script(register, ["end"], stdin=hook_json("SessionEnd"), env=hook_env(stub.url, PATH=path_with(fake.parent)))
    assert r.returncode == 0 and r.stderr == ""
    assert not (hook_env.state / f"notice-{SID}").exists()
    assert len(stub.requests("/sessions/end")) == 1, "the end is still posted"


# ============================== 10. a2a-pending never lets a shell error reach stderr ================


@pytest.mark.parametrize(
    "stdin",
    ["\x00\x01\x02 binary \xff", '{"session_id": "' + "\\" * 5000, '"session_id" "session_id" : :', "{" * 100000],
    ids=["binary", "backslashes", "colons", "huge"],
)
def test_pending_with_a_corrupt_input_is_exit_0_with_empty_stderr(pending, stub, hook_env, stdin):
    stub.script("/wake/pending", Reply(200, PENDING_JSON % 2))
    r = run_script(pending, [], stdin=stdin, env=hook_env(stub.url))
    assert r.returncode == 0 and r.stdout == "" and r.stderr == ""


def test_pending_prints_no_shell_error_when_its_stdout_is_closed(pending, stub, hook_env):
    """printf on a closed stdout is a shell error (`Bad file descriptor`); it must not reach stderr."""
    stub.script("/wake/pending", Reply(200, PENDING_JSON % 2))
    r = subprocess.run(
        ["sh", "-c", 'exec "$@" >&-', "x", DASH, str(pending)],
        input=hook_json("UserPromptSubmit"),
        capture_output=True,
        text=True,
        env=hook_env(stub.url),
        timeout=30,
        check=False,
    )
    assert r.returncode == 0 and r.stderr == ""
    assert len(stub.requests("/wake/pending")) == 1


@pytest.mark.parametrize("value", ["08", "09", "010"])
def test_a_retry_after_with_a_leading_zero_is_ignored_not_read_as_octal(listen, stub, hook_env, value):
    """`Retry-After: 08` reached `left=$((left - POLL))` as `08`, a bad octal that kills dash (exit 2,
    then the EXIT guard's silent exit 0): the listener must stay up and use its own backoff."""
    stub.script("/wake/listen", listen_reply(503, "", **{"Retry-After": value}))
    proc = start_script(listen, stdin=stop_input(), env=hook_env(stub.url))
    try:
        wait_for(lambda: any("backing off" in line for line in log_lines(hook_env)), 8, "the first back-off")
        (line,) = [x for x in log_lines(hook_env) if "backing off" in x]
        assert line.endswith("backing off 1s"), line
        assert proc.poll() is None, "the listener is still running"
    finally:
        proc.send_signal(signal.SIGTERM)
        proc.communicate(timeout=10)
        kill_quietly(proc)
