"""S1-CLAUDE: `bin/a2a-listen`, the asyncRewake listener, driven as a hook runs it (hook JSON on
stdin, a minimal environment) under dash against a stub HTTP server. No Docker needed. The same script
against the real server is in `test_hooks_e2e.py`.

Acceptance covered (plan S1-CLAUDE, api 7.1 and 11.1; BP2, BP3, BP7):

- the status table: 200 wakes (exit 2, one validated integer on stderr), 408 loops, 409 leaves
  silently, 401, 403 and 410 write the marker and exit 2 once and are silent the second time, 429
  and 5xx back off, and the backoff resets when the call lasted long enough;
- the `410 unregistered` retry of the first 15 s (BP7);
- guards: attended=0, bad session id, events and SessionStart sources that must not arm a listener;
- the key reaches curl on stdin only (argv and environment of the script and of curl);
- the owner-process watch, with a scratch parent killed with `kill -9`.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import time

import pytest
from hook_helpers import (
    CARD,
    DASH,
    SID,
    Reply,
    descendants_of,
    environ_of,
    cmdline_of,
    find_curl_child,
    hook_env,  # noqa: F401  (fixture)
    hook_json,
    kill_quietly,
    listen_reply,
    pid_alive,
    plugin_file,
    processes_with_bytes_in_cmdline,
    run_script,
    start_script,
    stub,  # noqa: F401  (fixture)
    wait_for,
)


@pytest.fixture
def listen():
    return plugin_file("bin/a2a-listen")


def stop_input(**extra: object) -> str:
    return hook_json("Stop", **extra)


def fast(hook_env, url, **extra):
    """A listener environment with 1 s rounds (the server caps a round at 900 s; the script takes
    whatever is in A2A_ROUND_S up to that)."""
    return hook_env(url, A2A_ROUND_S="1", **extra)


def no_request(stub):
    assert stub.requests() == []


def stderr_of_wake(n: int) -> str:
    return f"[a2a] {n} pending. Call a2a_inbox.\n"


def stopped_text(code: int) -> str:
    return f"[a2a] wake listener stopped: the server answered {code}. Check the coordination server and the API key.\n"


# ===================================== the status table (api 7.1) ================================


@pytest.mark.parametrize(
    "stdin",
    [
        stop_input(),
        hook_json("UserPromptSubmit", prompt="hello"),
        hook_json("SessionStart", source="startup"),
        hook_json("SessionStart", source="resume"),
        hook_json("SessionStart", source="clear"),
    ],
    ids=["stop", "user-prompt-submit", "startup", "resume", "clear"],
)
def test_200_prints_the_constant_stub_on_stderr_and_exits_2(listen, stub, hook_env, stdin):
    stub.script("/wake/listen", listen_reply(200, "3", **{"Content-Type": "text/plain"}))
    r = run_script(listen, stdin=stdin, env=hook_env(stub.url))
    assert r.returncode == 2
    assert r.stderr == stderr_of_wake(3) and r.stdout == ""
    (req,) = stub.requests("/wake/listen")
    assert req.method == "POST" and req.body == ""
    assert req.headers["authorization"] == f"Bearer {hook_env.key}"
    assert req.headers["x-coord-session"] == SID
    assert req.headers["x-coord-wait"] == "900", "the default round is 900 s"
    assert req.headers["x-coord-again"] == "1"
    # only the X-Coord-* spellings of api 7.1; the spike's short names are not sent
    assert not {"x-session", "x-wait", "x-again"} & set(req.headers)


@pytest.mark.parametrize("body", ["1", "42\n", "9999", "7\r\n"])
def test_200_with_one_integer_of_one_to_four_digits_wakes(listen, stub, hook_env, body):
    stub.script("/wake/listen", listen_reply(200, body))
    r = run_script(listen, stdin=stop_input(), env=hook_env(stub.url))
    assert r.returncode == 2 and r.stderr == stderr_of_wake(int(body))


@pytest.mark.parametrize(
    "body",
    ["", "0 pending", "12345", "-1", "abc", "1\n2", "1 2", " 3", "3.5", "[a2a] 2 pending", "٣", "<x>"],
    ids=["empty", "text", "five-digits", "negative", "word", "two-lines", "two-words", "leading-space", "decimal", "stub-text", "arabic-digit", "markup"],
)
def test_a_200_whose_body_is_not_one_integer_never_wakes(listen, stub, hook_env, body):
    """The wake text is a constant with one validated integer in it: whatever else arrives on the
    wake path is treated as a server error (back off), never printed."""
    stub.script("/wake/listen", listen_reply(200, body))
    proc = start_script(listen, stdin=stop_input(), env=fast(hook_env, stub.url))
    try:
        wait_for(lambda: len(stub.requests("/wake/listen")) >= 2, 8, "a second round after a back-off")
        assert proc.poll() is None, "a bad 200 must not end the listener"
    finally:
        proc.send_signal(signal.SIGTERM)
        out, err = proc.communicate(timeout=10)
    assert proc.returncode == 0 and err == "" and out == ""


def test_408_loops_at_once_and_counts_the_rounds(listen, stub, hook_env):
    stub.script("/wake/listen", listen_reply(408), listen_reply(408), listen_reply(200, "1"))
    t0 = time.monotonic()
    r = run_script(listen, stdin=stop_input(), env=fast(hook_env, stub.url))
    assert r.returncode == 2 and r.stderr == stderr_of_wake(1)
    reqs = stub.requests("/wake/listen")
    assert [q.headers["x-coord-again"] for q in reqs] == ["1", "2", "3"]
    assert all(q.headers["x-coord-wait"] == "1" for q in reqs)
    assert time.monotonic() - t0 < 12


def test_409_superseded_exits_0_silently_and_writes_no_marker(listen, stub, hook_env):
    stub.script("/wake/listen", listen_reply(409, **{"X-Coord-Reason": "superseded"}))
    r = run_script(listen, stdin=stop_input(), env=hook_env(stub.url))
    assert r.returncode == 0 and r.stdout == "" and r.stderr == ""
    assert len(stub.requests("/wake/listen")) == 1
    assert not (hook_env.state / f"notice-{SID}").exists()


@pytest.mark.parametrize(
    "status,headers",
    [(401, {"WWW-Authenticate": "Bearer"}), (403, {}), (410, {"X-Coord-Reason": "ended"})],
    ids=["401", "403", "410-ended"],
)
def test_401_403_410_write_the_marker_and_exit_2_once_then_are_silent(listen, stub, hook_env, status, headers):
    stub.script("/wake/listen", listen_reply(status, "", **headers))
    env = hook_env(stub.url)
    first = run_script(listen, stdin=stop_input(), env=env)
    assert first.returncode == 2 and first.stderr == stopped_text(status) and first.stdout == ""
    assert (hook_env.state / f"notice-{SID}").exists()
    second = run_script(listen, stdin=stop_input(), env=env)
    assert second.returncode == 0 and second.stderr == "" and second.stdout == "", "the second occurrence is silent"
    third = run_script(listen, stdin=hook_json("UserPromptSubmit"), env=env)
    assert third.returncode == 0 and third.stderr == ""


def test_a_healthy_round_clears_the_marker_so_a_later_failure_is_told_again(listen, stub, hook_env):
    marker = hook_env.state / f"notice-{SID}"
    hook_env.state.mkdir(parents=True, exist_ok=True)
    marker.write_text("")
    stub.script("/wake/listen", listen_reply(408), listen_reply(200, "2"))
    r = run_script(listen, stdin=stop_input(), env=fast(hook_env, stub.url))
    assert r.returncode == 2 and r.stderr == stderr_of_wake(2)
    assert not marker.exists(), "a 408 round (the server and the key work) removes the marker"
    stub.script("/wake/listen", listen_reply(401))
    again = run_script(listen, stdin=stop_input(), env=hook_env(stub.url))
    assert again.returncode == 2 and again.stderr == stopped_text(401)


def test_the_marker_is_per_session(listen, stub, hook_env):
    stub.script("/wake/listen", listen_reply(401))
    env = hook_env(stub.url)
    assert run_script(listen, stdin=stop_input(), env=env).returncode == 2
    assert run_script(listen, stdin=stop_input(), env=env).returncode == 0
    other = run_script(listen, stdin=hook_json("Stop", sid="another-session-id"), env=env)
    assert other.returncode == 2, "another session has its own notice"


def test_a_session_ended_by_a_register_end_leaves_its_listener_silent(listen, stub, hook_env):
    """/clear fires SessionEnd for the old session and keeps the claude process: the old session's
    listener, closed by the server with 410, must not wake the new session. `a2a-register end` writes
    the marker first, so the 410 finds it."""
    register = plugin_file("bin/a2a-register")
    stub.script("/sessions/end", Reply(200, "{}"))
    stub.script("/wake/listen", listen_reply(410, "", **{"X-Coord-Reason": "ended"}))
    env = hook_env(stub.url)
    assert run_script(register, ["end"], stdin=hook_json("SessionEnd"), env=env).returncode == 0
    r = run_script(listen, stdin=stop_input(), env=env)
    assert r.returncode == 0 and r.stderr == "" and r.stdout == ""


# ---- 410 unregistered: the 15 s retry (BP7) -----------------------------------------------------


def test_410_unregistered_inside_the_start_window_is_retried_until_the_registration_lands(listen, stub, hook_env):
    unreg = listen_reply(410, "", **{"X-Coord-Reason": "unregistered"})
    stub.script("/wake/listen", unreg, unreg, listen_reply(200, "1"))
    r = run_script(listen, stdin=hook_json("SessionStart", source="startup"), env=hook_env(stub.url))
    assert r.returncode == 2 and r.stderr == stderr_of_wake(1)
    reqs = stub.requests("/wake/listen")
    assert len(reqs) == 3
    assert reqs[1].at - reqs[0].at >= 0.9, "a pause between the retries"
    assert not (hook_env.state / f"notice-{SID}").exists()


def test_410_unregistered_after_the_window_is_final(listen, stub, hook_env):
    stub.script("/wake/listen", listen_reply(410, "", **{"X-Coord-Reason": "unregistered"}))
    t0 = time.monotonic()
    r = run_script(listen, stdin=stop_input(), env=hook_env(stub.url, A2A_410_RETRY_S="2"))
    assert r.returncode == 2 and r.stderr == stopped_text(410)
    assert 1.5 <= time.monotonic() - t0 < 8, "retried for about the window, then gave up"
    assert 2 <= len(stub.requests("/wake/listen")) <= 4


def test_410_unregistered_is_final_at_once_with_a_zero_window(listen, stub, hook_env):
    stub.script("/wake/listen", listen_reply(410, "", **{"X-Coord-Reason": "unregistered"}))
    r = run_script(listen, stdin=stop_input(), env=hook_env(stub.url, A2A_410_RETRY_S="0"))
    assert r.returncode == 2 and r.stderr == stopped_text(410)
    assert len(stub.requests("/wake/listen")) == 1


def test_410_ended_on_a_stop_or_prompt_event_is_never_retried(listen, stub, hook_env):
    stub.script("/wake/listen", listen_reply(410, "", **{"X-Coord-Reason": "ended"}))
    r = run_script(listen, stdin=stop_input(), env=hook_env(stub.url))
    assert r.returncode == 2 and r.stderr == stopped_text(410)
    assert len(stub.requests("/wake/listen")) == 1


def test_410_ended_at_session_start_is_retried_until_the_revive_lands(listen, stub, hook_env):
    """`claude --resume` of a session an earlier SessionEnd closed: the listener can park before
    `a2a-register start` has revived the session, so the server answers 410 ended (review finding)."""
    ended = listen_reply(410, "", **{"X-Coord-Reason": "ended"})
    stub.script("/wake/listen", ended, ended, listen_reply(200, "2"))
    r = run_script(listen, stdin=hook_json("SessionStart", source="resume"), env=hook_env(stub.url))
    assert r.returncode == 2 and r.stderr == stderr_of_wake(2)
    assert len(stub.requests("/wake/listen")) == 3
    assert not (hook_env.state / f"notice-{SID}").exists()


def test_410_ended_at_session_start_is_final_after_the_window(listen, stub, hook_env):
    stub.script("/wake/listen", listen_reply(410, "", **{"X-Coord-Reason": "ended"}))
    r = run_script(listen, stdin=hook_json("SessionStart", source="startup"), env=hook_env(stub.url, A2A_410_RETRY_S="0"))
    assert r.returncode == 2 and r.stderr == stopped_text(410)
    assert len(stub.requests("/wake/listen")) == 1


# ---- shell errors never reach stderr, which an exit 2 shows the model (review finding) -------------


def test_an_unwritable_log_does_not_put_shell_errors_in_the_wake_text(listen, stub, hook_env):
    stub.script("/wake/listen", listen_reply(200, "3"))
    hook_env.state.mkdir(mode=0o700, exist_ok=True)
    log = hook_env.state / "listen.log"
    log.write_text("")
    log.chmod(0)
    try:
        r = run_script(listen, stdin=stop_input(), env=hook_env(stub.url))
    finally:
        log.chmod(0o600)
    assert r.returncode == 2
    assert r.stderr == stderr_of_wake(3), "only the constant stub, no path and no shell error"


def test_an_oversized_unwritable_log_is_a_silent_exit_not_a_false_wake(listen, stub, hook_env):
    stub.script("/wake/listen", listen_reply(408), listen_reply(408), listen_reply(409))
    hook_env.state.mkdir(mode=0o700, exist_ok=True)
    log = hook_env.state / "listen.log"
    log.write_text("x" * 300_000)
    log.chmod(0o400)
    r = run_script(listen, stdin=stop_input(), env=fast(hook_env, stub.url), timeout=30)
    assert r.returncode == 0 and r.stderr == "" and r.stdout == ""


def test_a_number_too_long_for_shell_arithmetic_keeps_the_default(listen, stub, hook_env):
    stub.script("/wake/listen", listen_reply(200, "1"))
    r = run_script(listen, stdin=stop_input(), env=hook_env(stub.url, A2A_ROUND_S="9" * 25))
    assert r.returncode == 2 and r.stderr == stderr_of_wake(1)
    (req,) = stub.requests("/wake/listen")
    assert req.headers["x-coord-wait"] == "900"


# ---- 429, 5xx, no answer: back off, never wake ---------------------------------------------------


def gaps(reqs):
    return [b.at - a.at for a, b in zip(reqs, reqs[1:])]


def test_5xx_backs_off_with_doubling_delays_and_a_later_200_still_wakes(listen, stub, hook_env):
    stub.script("/wake/listen", listen_reply(503), listen_reply(500), listen_reply(502), listen_reply(200, "1"))
    r = run_script(listen, stdin=stop_input(), env=hook_env(stub.url), timeout=40)
    assert r.returncode == 2 and r.stderr == stderr_of_wake(1)
    g = gaps(stub.requests("/wake/listen"))
    assert len(g) == 3
    assert 0.9 <= g[0] < 2.2 and 1.9 <= g[1] < 3.5 and 3.9 <= g[2] < 5.5, g


def test_a_retry_after_longer_than_the_backoff_is_honoured(listen, stub, hook_env):
    stub.script("/wake/listen", listen_reply(429, "", **{"Retry-After": "3"}), listen_reply(200, "1"))
    r = run_script(listen, stdin=stop_input(), env=hook_env(stub.url))
    assert r.returncode == 2
    assert gaps(stub.requests("/wake/listen"))[0] >= 2.9


def test_503_with_retry_after_5_as_the_server_sends_on_sigterm(listen, stub, hook_env):
    stub.script("/wake/listen", listen_reply(503, "", **{"Retry-After": "5"}), listen_reply(200, "1"))
    r = run_script(listen, stdin=stop_input(), env=hook_env(stub.url), timeout=30)
    assert r.returncode == 2
    assert gaps(stub.requests("/wake/listen"))[0] >= 4.9


def test_the_backoff_is_capped(listen, stub, hook_env):
    stub.script("/wake/listen", *[listen_reply(500)] * 4, listen_reply(200, "1"))
    r = run_script(listen, stdin=stop_input(), env=hook_env(stub.url, A2A_BACKOFF_MAX_S="2"), timeout=40)
    assert r.returncode == 2
    g = gaps(stub.requests("/wake/listen"))
    assert max(g) < 3.4 and g[2] >= 1.9, g  # 1, 2, 2, 2 instead of 1, 2, 4, 8


def test_a_call_that_lasted_long_enough_resets_the_backoff(listen, stub, hook_env):
    """Each failing call lasts 1.2 s (the reset threshold is set to 1 s here; the default is 10 s), so
    every pause stays at 1 s instead of doubling. The call is noticed on the next 1 s poll tick, so
    arrival gaps stay near 3 s (2 s noticed, 1 s pause), not 3, 4, 6."""
    slow = Reply(503, "", delay=1.2)
    stub.script("/wake/listen", slow, slow, slow, listen_reply(200, "1"))
    r = run_script(listen, stdin=stop_input(), env=hook_env(stub.url, A2A_BACKOFF_RESET_S="1"), timeout=40)
    assert r.returncode == 2
    g = gaps(stub.requests("/wake/listen"))
    assert len(g) == 3 and max(g) < 3.6, g


def test_the_default_reset_threshold_is_10_seconds_and_the_default_round_900(listen):
    text = listen.read_text()
    assert 'num "${A2A_BACKOFF_RESET_S:-}" 10 ' in text
    assert 'num "${A2A_ROUND_S:-}" 900 ' in text
    assert "--max-time" in text and "ROUND + 30" in text


@pytest.mark.parametrize("status", [400, 404, 405, 413, 418])
def test_a_client_error_the_table_does_not_list_ends_the_listener_silently(listen, stub, hook_env, status):
    stub.script("/wake/listen", listen_reply(status, "{}"))
    r = run_script(listen, stdin=stop_input(), env=hook_env(stub.url))
    assert r.returncode == 0 and r.stdout == "" and r.stderr == ""
    assert len(stub.requests("/wake/listen")) == 1


def test_no_answer_at_all_backs_off_and_keeps_listening_until_terminated(listen, stub, hook_env):
    port = stub.port
    stub.close()  # nothing listens on this port now
    proc = start_script(listen, stdin=stop_input(), env=hook_env(f"http://127.0.0.1:{port}"))
    try:
        time.sleep(3.0)
        assert proc.poll() is None, "a down server is a back-off, not an exit"
    finally:
        proc.send_signal(signal.SIGTERM)
        out, err = proc.communicate(timeout=10)
    assert proc.returncode == 0 and out == "" and err == ""


# ===================================================== guards ====================================


def guard_cases():
    return [
        ("attended-0", stop_input(), {"CLAUDE_CODE_SESSION_ATTENDED": "0"}),
        ("compact", hook_json("SessionStart", source="compact"), {}),
        ("source-missing", hook_json("SessionStart"), {}),
        ("source-other", hook_json("SessionStart", source="other"), {}),
        ("event-sessionend", hook_json("SessionEnd"), {}),
        ("event-pretooluse", hook_json("PreToolUse"), {}),
        ("event-missing", '{"session_id": "%s"}' % SID, {}),
        ("sid-space", hook_json("Stop", sid="bad id!"), {}),
        ("sid-path", hook_json("Stop", sid="../etc"), {}),
        ("sid-dot", hook_json("Stop", sid="a.b"), {}),
        ("sid-empty", hook_json("Stop", sid=""), {}),
        ("sid-long", hook_json("Stop", sid="a" * 129), {}),
        ("sid-missing", '{"hook_event_name": "Stop"}', {}),
        ("stdin-empty", "", {}),
        ("stdin-garbage", "not json", {}),
    ]


@pytest.mark.parametrize("name,stdin,extra", guard_cases(), ids=[c[0] for c in guard_cases()])
def test_guards_exit_0_at_once_with_no_request_and_no_output(listen, stub, hook_env, name, stdin, extra):
    stub.script("/wake/listen", listen_reply(200, "1"))
    t0 = time.monotonic()
    r = run_script(listen, stdin=stdin, env=hook_env(stub.url, **extra))
    assert r.returncode == 0 and r.stdout == "" and r.stderr == ""
    assert time.monotonic() - t0 < 3
    no_request(stub)


def test_attended_0_is_checked_before_anything_else_even_with_a_bad_key_file(listen, stub, hook_env):
    r = run_script(listen, stdin=stop_input(), env=hook_env(stub.url, CLAUDE_CODE_SESSION_ATTENDED="0", A2A_KEY_FILE="/nonexistent/key"))
    assert r.returncode == 0 and r.stderr == ""


def test_no_key_file_exits_0_with_no_request_and_never_uses_a2a_api_key_from_the_environment(listen, stub, hook_env):
    stub.script("/wake/listen", listen_reply(200, "1"))
    env = hook_env(stub.url, A2A_KEY_FILE=str(hook_env.tmp / "missing"), A2A_API_KEY="a2ak_test_fromenv_secretvalue")
    r = run_script(listen, stdin=stop_input(), env=env)
    assert r.returncode == 0 and r.stderr == ""
    no_request(stub)


@pytest.mark.parametrize("bad", ['abc"\noutput = /tmp/pwned', "has space", 'q"uote', "", "semi;colon"])
def test_a_key_that_could_break_out_of_the_curl_config_line_is_refused(listen, stub, hook_env, bad):
    hook_env.key_file.write_text(bad + "\n")
    stub.script("/wake/listen", listen_reply(200, "1"))
    r = run_script(listen, stdin=stop_input(), env=hook_env(stub.url))
    assert r.returncode == 0 and r.stderr == ""
    no_request(stub)
    assert not (hook_env.tmp / "pwned").exists()


def test_a_state_directory_that_cannot_be_made_exits_0(listen, stub, hook_env):
    blocker = hook_env.tmp / "file-in-the-way"
    blocker.write_text("")
    r = run_script(listen, stdin=stop_input(), env=hook_env(stub.url, A2A_STATE_DIR=str(blocker / "sub")))
    assert r.returncode == 0 and r.stderr == ""
    no_request(stub)


def test_the_script_is_directly_executable_through_its_shebang(listen, stub, hook_env):
    assert os.access(listen, os.X_OK)
    stub.script("/wake/listen", listen_reply(200, "5"))
    r = subprocess.run([str(listen)], input=stop_input(), capture_output=True, text=True, env=hook_env(stub.url), timeout=30)
    assert r.returncode == 2 and r.stderr == stderr_of_wake(5)


# ===================================== the key stays out of argv and the environment =============


def test_the_key_is_never_in_argv_or_in_the_environment_of_the_script_or_of_curl(listen, stub, hook_env):
    key = hook_env.key
    stub.script("/wake/listen", Reply(408, "", delay=20.0))  # a parked round
    env = hook_env(stub.url, A2A_API_KEY=key, A2A_ROUND_S="900")  # the harness exports the key; the script must not pass it on
    proc = start_script(listen, stdin=stop_input(), env=env)
    try:
        curl_pid = find_curl_child(proc.pid)
        wait_for(lambda: stub.requests("/wake/listen"), 5, "the parked request")
        assert key.encode() not in cmdline_of(curl_pid), "key in curl's argv"
        assert key.encode() not in cmdline_of(proc.pid), "key in the script's argv"
        assert key.encode() not in environ_of(curl_pid), "curl inherited the key"
        assert b"A2A_API_KEY" not in environ_of(curl_pid), "A2A_API_KEY is unset before curl starts"
        assert processes_with_bytes_in_cmdline(key.encode()) == [], "some process has the key in its argv"
        assert stub.requests("/wake/listen")[0].headers["authorization"] == f"Bearer {key}", "curl did send it, from stdin"
        # no file the script writes holds the key either
        for path in hook_env.state.rglob("*"):
            if path.is_file():
                assert key.encode() not in path.read_bytes(), path
    finally:
        proc.send_signal(signal.SIGTERM)
        proc.communicate(timeout=10)
        kill_quietly(proc)


def test_the_log_holds_no_hook_input_no_key_and_no_server_text(listen, stub, hook_env):
    sentinel = "SENTINEL-PROMPT-TEXT-12345"
    stub.script("/wake/listen", listen_reply(401, "SERVER-BODY-SENTINEL"))
    stdin = hook_json("UserPromptSubmit", prompt=sentinel, cwd="/home/user/work", transcript_path="/home/user/t.jsonl")
    run_script(listen, stdin=stdin, env=hook_env(stub.url))
    log = (hook_env.state / "listen.log").read_text()
    assert log.strip(), "the log is written"
    for needle in (sentinel, "/home/user", hook_env.key, "SERVER-BODY-SENTINEL", SID):
        assert needle not in log, needle


def test_the_log_is_capped_and_old_markers_are_removed(listen, stub, hook_env):
    hook_env.state.mkdir(parents=True, exist_ok=True)
    (hook_env.state / "listen.log").write_text("x" * 300_000)
    old = hook_env.state / "notice-old-session"
    new = hook_env.state / "notice-new-session"
    old.write_text("")
    new.write_text("")
    ten_days = time.time() - 10 * 86400
    os.utime(old, (ten_days, ten_days))
    stub.script("/wake/listen", listen_reply(200, "1"))
    run_script(listen, stdin=stop_input(), env=hook_env(stub.url))
    assert (hook_env.state / "listen.log").stat().st_size < 100_000
    assert not old.exists() and new.exists()


def test_files_are_private(listen, stub, hook_env):
    stub.script("/wake/listen", listen_reply(401))
    run_script(listen, stdin=stop_input(), env=hook_env(stub.url))
    assert (hook_env.state.stat().st_mode & 0o077) == 0
    for path in hook_env.state.iterdir():
        assert (path.stat().st_mode & 0o077) == 0, path


def test_temp_files_do_not_outlive_a_run(listen, stub, hook_env):
    stub.script("/wake/listen", listen_reply(200, "1"))
    run_script(listen, stdin=stop_input(), env=hook_env(stub.url))
    assert [p.name for p in hook_env.state.iterdir() if p.name.startswith("run.")] == []


# ================================================ signals and the owner process ==================


def parked(stub, hook_env, **extra):
    stub.script("/wake/listen", Reply(408, "", delay=60.0))
    stub.script("/sessions/end", Reply(200, "{}"))
    return hook_env(stub.url, A2A_ROUND_S="900", **extra)


def wait_parked(stub):
    wait_for(lambda: stub.requests("/wake/listen"), 10, "the listener to park")


def test_sigterm_while_parked_exits_0_silently_and_takes_curl_with_it(listen, stub, hook_env):
    proc = start_script(listen, stdin=stop_input(), env=parked(stub, hook_env))
    try:
        wait_parked(stub)
        curl_pid = find_curl_child(proc.pid)
        proc.send_signal(signal.SIGTERM)
        out, err = proc.communicate(timeout=5)
    finally:
        kill_quietly(proc)
    assert proc.returncode == 0 and out == "" and err == ""
    wait_for(lambda: not pid_alive(curl_pid), 5, "curl to end")


def scratch_parent() -> subprocess.Popen:
    return subprocess.Popen(["sleep", "600"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def test_kill_9_of_the_owner_ends_the_listener_within_a_few_seconds_and_posts_the_end(listen, stub, hook_env):
    parent = scratch_parent()
    proc = start_script(listen, stdin=stop_input(), env=parked(stub, hook_env, A2A_OWNER_PID=str(parent.pid)))
    try:
        wait_parked(stub)
        curl_pid = find_curl_child(proc.pid)
        os.kill(parent.pid, signal.SIGKILL)
        parent.wait(timeout=5)
        t0 = time.monotonic()
        out, err = proc.communicate(timeout=10)
        took = time.monotonic() - t0
    finally:
        kill_quietly(proc)
        kill_quietly(parent)
    assert proc.returncode == 0 and out == "" and err == ""
    assert took < 4.5, f"the listener took {took:.1f} s to notice its owner was gone"
    wait_for(lambda: not pid_alive(curl_pid), 5, "curl to end")
    (end,) = stub.requests("/sessions/end")
    assert json.loads(end.body) == {"card": CARD, "harness_session_id": SID}
    assert end.headers["authorization"] == f"Bearer {hook_env.key}"


def test_an_owner_that_is_a_zombie_counts_as_gone(listen, stub, hook_env):
    """kill -0 succeeds on a zombie, so the watch also reads the state in /proc: a killed owner
    that nobody has waited for yet (the test does not reap it) still ends the listener."""
    parent = scratch_parent()
    proc = start_script(listen, stdin=stop_input(), env=parked(stub, hook_env, A2A_OWNER_PID=str(parent.pid)))
    try:
        wait_parked(stub)
        os.kill(parent.pid, signal.SIGKILL)  # not reaped: a zombie of this test process
        wait_for(lambda: not pid_alive(parent.pid), 5, "the owner to become a zombie")
        assert os.path.exists(f"/proc/{parent.pid}"), "still in the process table, as a zombie"
        out, err = proc.communicate(timeout=10)
    finally:
        kill_quietly(proc)
        kill_quietly(parent)
    assert proc.returncode == 0 and out == "" and err == ""


def test_claude_pid_is_the_owner_when_no_override_is_given_and_the_parent_is_not(listen, stub, hook_env):
    parent = scratch_parent()
    proc = start_script(listen, stdin=stop_input(), env=parked(stub, hook_env, CLAUDE_PID=str(parent.pid)))
    try:
        wait_parked(stub)
        time.sleep(2.2)
        assert proc.poll() is None, "the listener's own parent (this test) is alive and is not the owner"
        os.kill(parent.pid, signal.SIGKILL)
        parent.wait(timeout=5)
        out, err = proc.communicate(timeout=10)
    finally:
        kill_quietly(proc)
        kill_quietly(parent)
    assert proc.returncode == 0 and out == "" and err == ""


def test_the_parent_is_the_owner_when_claude_pid_is_absent_or_not_a_number(listen, stub, hook_env, tmp_path):
    for bad in (None, "not-a-pid", "0", "1"):
        stub.seen.clear()
        extra = {} if bad is None else {"CLAUDE_PID": bad}
        stdin_file = tmp_path / "in.json"
        stdin_file.write_text(stop_input())
        env = parked(stub, hook_env, **extra)
        # `sh -c` is the scratch parent; the listener runs as its child and its $PPID is that sh
        parent = subprocess.Popen(
            ["sh", "-c", f"{DASH} {listen} < {stdin_file} & wait"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        try:
            wait_parked(stub)
            kids = descendants_of(parent.pid)
            assert kids
            os.kill(parent.pid, signal.SIGKILL)
            parent.wait(timeout=5)
            wait_for(lambda: all(not pid_alive(k) for k in kids if k != parent.pid), 8, f"the listener to end (CLAUDE_PID={bad})")
        finally:
            kill_quietly(parent)
            for k in kids:
                try:
                    os.kill(k, signal.SIGKILL)
                except ProcessLookupError:
                    pass


def test_an_owner_that_is_already_gone_at_start_exits_0_without_a_request(listen, stub, hook_env):
    dead = scratch_parent()
    dead.kill()
    dead.wait()
    stub.script("/wake/listen", listen_reply(200, "1"))
    r = run_script(listen, stdin=stop_input(), env=hook_env(stub.url, A2A_OWNER_PID=str(dead.pid)))
    assert r.returncode == 0 and r.stderr == ""
    no_request(stub)


def test_the_owner_is_watched_while_backing_off_too(listen, stub, hook_env):
    parent = scratch_parent()
    stub.script("/wake/listen", listen_reply(503, "", **{"Retry-After": "30"}))
    stub.script("/sessions/end", Reply(200, "{}"))
    proc = start_script(listen, stdin=stop_input(), env=hook_env(stub.url, A2A_OWNER_PID=str(parent.pid)))
    try:
        wait_parked(stub)
        time.sleep(1.2)  # now in the 30 s back-off
        os.kill(parent.pid, signal.SIGKILL)
        parent.wait(timeout=5)
        t0 = time.monotonic()
        out, err = proc.communicate(timeout=10)
        assert time.monotonic() - t0 < 5
    finally:
        kill_quietly(proc)
        kill_quietly(parent)
    assert proc.returncode == 0 and out == "" and err == ""
    assert len(stub.requests("/sessions/end")) == 1


def test_a_superseded_listener_does_not_post_an_end(listen, stub, hook_env):
    stub.script("/wake/listen", listen_reply(409, **{"X-Coord-Reason": "superseded"}))
    run_script(listen, stdin=stop_input(), env=hook_env(stub.url))
    assert stub.requests("/sessions/end") == []


def test_no_other_runtime_is_needed(listen):
    """The scripts are POSIX sh plus curl: no python, jq, node or bun in them."""
    for name in ("a2a-listen", "a2a-register", "a2a-pending"):
        text = plugin_file(f"bin/{name}").read_text()
        code = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))
        for tool in ("python", "jq ", "node ", "bun ", "perl ", "ruby ", "agy", "claude "):
            assert tool not in code, (name, tool)
        assert text.startswith("#!/bin/sh\n")
    assert shutil.which("curl")
