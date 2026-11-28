"""AW2 (decision Z23): `bin/a2a-agy-listen`, the opt-in idle-wake listener of an Antigravity session.

The script runs as the session's own background command would run it (`dash script <conversation-id>`,
no stdin), against `StubServer` for the status codes and shapes the real server cannot easily
produce (the real server is in `test_agy_wake_e2e.py`). Modelled on `test_hooks_listen.py`.

What is pinned here:

- the status table of api 7.1 as Z23 decision 5 maps it: `200` prints one constant line with one
  validated integer and exits 0; `408` loops; `409`, `401`, `403`, and `410` after the 15 s race window
  exit 0 silently; `429`/`5xx` back off; an unlisted status exits 0;
- `A2A_LISTEN_MAX_S`: after it, the line `[a2a] listener expired; re-arm.` and exit 0, also while a
  round is parked;
- the owner (parent) process watch: a parent killed with `kill -9` ends the listener silently;
- the key reaches curl on stdin only (argv and environment of the script and of curl);
- stderr is never written and the exit status is 0 on every path.
"""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.hooks

import signal
import subprocess
import time

from hook_helpers import (
    DASH,
    Reply,
    cmdline_of,
    descendants_of,
    environ_of,
    find_curl_child,
    hook_env,  # noqa: F401  (fixture)
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

CONV = "77efe5b3-dee5-474c-8b26-c37267c8e353"


@pytest.fixture
def listen():
    return plugin_file("bin/a2a-agy-listen")


def env_for(hook_env, url, **extra):
    """The agy listener's environment: the agy key file, short rounds, no claude-only variables."""
    opts = {"A2A_AGY_KEY_FILE": str(hook_env.key_file), "A2A_ROUND_S": "1", **extra}
    env = hook_env(url, **opts)
    for name in ("A2A_KEY_FILE", "A2A_CARD", "CLAUDE_CODE_SESSION_ATTENDED"):
        env.pop(name, None)
    return env


def wake_text(n: int) -> str:
    return f"[a2a] {n} pending. Call a2a_inbox. Then re-arm the listener.\n"


EXPIRED = "[a2a] listener expired; re-arm.\n"


def quiet(r, code=0):
    assert r.returncode == code and r.stderr == "", r.stderr
    return r


# ===================================== the status table (api 7.1) ================================


def test_200_prints_the_constant_stub_on_stdout_and_exits_0(listen, stub, hook_env):
    stub.script("/wake/listen", listen_reply(200, "3", **{"Content-Type": "text/plain"}))
    env = env_for(hook_env, stub.url, A2A_ROUND_S="900")
    r = quiet(run_script(listen, [CONV], env=env))
    assert r.stdout == wake_text(3)
    (req,) = stub.requests("/wake/listen")
    assert req.method == "POST" and req.body == ""
    assert req.headers["authorization"] == f"Bearer {hook_env.key}"
    assert req.headers["x-coord-session"] == CONV
    assert req.headers["x-coord-wait"] == "900", "the default round is 900 s"
    assert req.headers["x-coord-again"] == "1"
    assert not {"x-session", "x-wait", "x-again"} & set(req.headers)


@pytest.mark.parametrize("body", ["1", "42\n", "9999", "7\r\n"])
def test_200_with_one_integer_of_one_to_four_digits_wakes(listen, stub, hook_env, body):
    stub.script("/wake/listen", listen_reply(200, body))
    r = quiet(run_script(listen, [CONV], env=env_for(hook_env, stub.url)))
    assert r.stdout == wake_text(int(body))


@pytest.mark.parametrize(
    "body",
    ["", "0 pending", "12345", "-1", "abc", "1\n2", "1 2", " 3", "3.5", "[a2a] 2 pending", "٣", "<x>", "0", "007"],
    ids=["empty", "text", "five-digits", "negative", "word", "two-lines", "two-words", "leading-space", "decimal", "stub-text", "arabic-digit", "markup", "zero", "leading-zero"],
)
def test_a_200_whose_body_is_not_one_integer_never_wakes(listen, stub, hook_env, body):
    stub.script("/wake/listen", listen_reply(200, body))
    proc = start_script(listen, [CONV], env=env_for(hook_env, stub.url))
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
    r = quiet(run_script(listen, [CONV], env=env_for(hook_env, stub.url)))
    assert r.stdout == wake_text(1)
    reqs = stub.requests("/wake/listen")
    assert [q.headers["x-coord-again"] for q in reqs] == ["1", "2", "3"]
    assert all(q.headers["x-coord-wait"] == "1" for q in reqs)
    assert time.monotonic() - t0 < 12


def test_409_superseded_exits_0_silently(listen, stub, hook_env):
    stub.script("/wake/listen", listen_reply(409, **{"X-Coord-Reason": "superseded"}))
    r = quiet(run_script(listen, [CONV], env=env_for(hook_env, stub.url)))
    assert r.stdout == ""
    assert len(stub.requests("/wake/listen")) == 1


@pytest.mark.parametrize(
    "status,headers",
    [(401, {"WWW-Authenticate": "Bearer"}), (403, {}), (410, {"X-Coord-Reason": "ended"}), (410, {"X-Coord-Reason": "unregistered"})],
    ids=["401", "403", "410-ended", "410-unregistered"],
)
def test_401_403_410_exit_0_silently_and_every_time(listen, stub, hook_env, status, headers):
    stub.script("/wake/listen", listen_reply(status, "", **headers))
    env = env_for(hook_env, stub.url, A2A_410_RETRY_S="0")
    for _ in range(2):  # no marker file: the second occurrence is as silent as the first
        r = quiet(run_script(listen, [CONV], env=env))
        assert r.stdout == ""
    assert len(stub.requests("/wake/listen")) == 2


def test_410_inside_the_race_window_is_retried_then_wakes(listen, stub, hook_env):
    stub.script(
        "/wake/listen",
        listen_reply(410, "", **{"X-Coord-Reason": "unregistered"}),
        listen_reply(410, "", **{"X-Coord-Reason": "ended"}),
        listen_reply(200, "2"),
    )
    t0 = time.monotonic()
    r = quiet(run_script(listen, [CONV], env=env_for(hook_env, stub.url)))
    assert r.stdout == wake_text(2)
    assert len(stub.requests("/wake/listen")) == 3
    assert time.monotonic() - t0 < 10


def test_410_stays_final_after_the_race_window(listen, stub, hook_env):
    stub.script("/wake/listen", listen_reply(410, "", **{"X-Coord-Reason": "unregistered"}))
    r = quiet(run_script(listen, [CONV], env=env_for(hook_env, stub.url, A2A_410_RETRY_S="3"), timeout=30))
    assert r.stdout == ""
    reqs = stub.requests("/wake/listen")
    assert len(reqs) >= 2, "retried inside the window, final after it"
    assert len(reqs) <= 5


@pytest.mark.parametrize("status", [400, 404, 413])
def test_an_unlisted_client_error_exits_0_without_looping(listen, stub, hook_env, status):
    stub.script("/wake/listen", listen_reply(status))
    r = quiet(run_script(listen, [CONV], env=env_for(hook_env, stub.url)))
    assert r.stdout == ""
    assert len(stub.requests("/wake/listen")) == 1


# ---- 429, 5xx, no answer: back off, never wake ---------------------------------------------------


def gaps(reqs):
    return [b.at - a.at for a, b in zip(reqs, reqs[1:])]


def test_5xx_backs_off_with_doubling_delays_and_a_later_200_still_wakes(listen, stub, hook_env):
    stub.script("/wake/listen", listen_reply(503), listen_reply(500), listen_reply(502), listen_reply(200, "1"))
    r = quiet(run_script(listen, [CONV], env=env_for(hook_env, stub.url), timeout=40))
    assert r.stdout == wake_text(1)
    g = gaps(stub.requests("/wake/listen"))
    assert len(g) == 3
    assert 0.9 <= g[0] < 2.2 and 1.9 <= g[1] < 3.5 and 3.9 <= g[2] < 5.5, g


def test_a_retry_after_longer_than_the_backoff_is_honoured(listen, stub, hook_env):
    stub.script("/wake/listen", listen_reply(429, "", **{"Retry-After": "3"}), listen_reply(200, "1"))
    r = quiet(run_script(listen, [CONV], env=env_for(hook_env, stub.url)))
    assert r.stdout == wake_text(1)
    assert gaps(stub.requests("/wake/listen"))[0] >= 2.9


def test_the_backoff_is_capped(listen, stub, hook_env):
    stub.script("/wake/listen", *[listen_reply(500)] * 4, listen_reply(200, "1"))
    r = quiet(run_script(listen, [CONV], env=env_for(hook_env, stub.url, A2A_BACKOFF_MAX_S="2"), timeout=40))
    assert r.stdout == wake_text(1)
    assert all(g < 3.6 for g in gaps(stub.requests("/wake/listen")))


# ---- lifetime ------------------------------------------------------------------------------------


def test_the_lifetime_ends_with_the_expiry_line_and_exit_0(listen, stub, hook_env):
    stub.script("/wake/listen", listen_reply(408))
    t0 = time.monotonic()
    r = quiet(run_script(listen, [CONV], env=env_for(hook_env, stub.url, A2A_LISTEN_MAX_S="2"), timeout=30))
    assert r.stdout == EXPIRED
    assert 1.5 <= time.monotonic() - t0 < 10


def test_the_lifetime_also_ends_a_round_that_is_parked(listen, stub, hook_env):
    stub.script("/wake/listen", Reply(408, delay=20))
    t0 = time.monotonic()
    r = quiet(run_script(listen, [CONV], env=env_for(hook_env, stub.url, A2A_LISTEN_MAX_S="2", A2A_ROUND_S="60"), timeout=30))
    assert r.stdout == EXPIRED
    assert time.monotonic() - t0 < 10, "the round of 60 s must not outlive the lifetime"


def test_the_default_lifetime_is_12_hours_and_a_bad_value_keeps_it(listen, stub, hook_env):
    text = listen.read_text()
    assert "A2A_LISTEN_MAX_S:-}\" 43200" in text
    stub.script("/wake/listen", listen_reply(200, "1"))
    r = quiet(run_script(listen, [CONV], env=env_for(hook_env, stub.url, A2A_LISTEN_MAX_S="0")))
    assert r.stdout == wake_text(1), "0 is not a lifetime: the default stays"


# ---- input: the conversation id, the key, the URL -----------------------------------------------


@pytest.mark.parametrize(
    "args",
    [[], [""], ["-x"], ["bad id"], ["a" * 129], ["a/b"], ["$(id)"], [".hidden"], ["x;y"]],
    ids=["none", "empty", "dash", "space", "long", "slash", "subst", "dot-first", "semicolon"],
)
def test_a_missing_or_invalid_conversation_id_makes_no_call(listen, stub, hook_env, args):
    r = quiet(run_script(listen, args, env=env_for(hook_env, stub.url)))
    assert r.stdout == ""
    assert stub.requests() == []


def test_no_usable_key_makes_no_call(listen, stub, hook_env):
    hook_env.key_file.write_text("not a key\n")
    r = quiet(run_script(listen, [CONV], env=env_for(hook_env, stub.url)))
    assert r.stdout == "" and stub.requests() == []


def test_the_key_is_read_out_of_an_mcp_config_style_file(listen, stub, hook_env):
    cfg = hook_env.tmp / "mcp_config.json"
    cfg.write_text(f'{{"mcpServers": {{"a2a-coord": {{"headers": {{"Authorization": "Bearer {hook_env.key}"}}}}}}}}\n')
    cfg.chmod(0o600)
    stub.script("/wake/listen", listen_reply(200, "5"))
    env = env_for(hook_env, stub.url, A2A_AGY_KEY_FILE=str(cfg))
    r = quiet(run_script(listen, [CONV], env=env))
    assert r.stdout == wake_text(5)
    assert stub.requests("/wake/listen")[0].headers["authorization"] == f"Bearer {hook_env.key}"


@pytest.mark.parametrize("url", ["ftp://127.0.0.1:1", "file:///etc/passwd", "http://x --config /etc/passwd", "127.0.0.1:8120"])
def test_a_url_that_is_not_plain_http_makes_no_call(listen, stub, hook_env, url):
    r = quiet(run_script(listen, [CONV], env=env_for(hook_env, url)))
    assert r.stdout == ""
    assert stub.requests() == []


def test_the_script_reads_nothing_from_stdin_and_runs_with_a_closed_one(listen, stub, hook_env):
    stub.script("/wake/listen", listen_reply(200, "1"))
    r = subprocess.run(
        [DASH, str(listen), CONV], stdin=subprocess.DEVNULL, capture_output=True, text=True, env=env_for(hook_env, stub.url), timeout=30
    )
    assert r.returncode == 0 and r.stdout == wake_text(1) and r.stderr == ""


# ---- the key stays off argv and out of the environment ------------------------------------------


def test_the_key_reaches_curl_on_stdin_only(listen, stub, hook_env):
    stub.script("/wake/listen", Reply(408, delay=3))
    env = env_for(hook_env, stub.url, A2A_ROUND_S="5")
    env["A2A_API_KEY"] = hook_env.key  # a leaked variable must not reach curl either
    proc = start_script(listen, [CONV], env=env)
    try:
        curl = find_curl_child(proc.pid)
        needle = hook_env.key.encode()
        assert needle not in cmdline_of(proc.pid) and needle not in cmdline_of(curl)
        assert needle not in environ_of(curl)  # the script unsets the variable, so curl never gets it
        assert b"A2A_API_KEY" not in environ_of(curl)
        assert processes_with_bytes_in_cmdline(needle) == []
    finally:
        kill_quietly(proc)


# ---- the owner process --------------------------------------------------------------------------


def test_the_listener_ends_silently_when_its_parent_is_killed(listen, stub, hook_env):
    stub.script("/wake/listen", Reply(408, delay=25))
    env = env_for(hook_env, stub.url, A2A_ROUND_S="60")
    parent = subprocess.Popen(
        ["sh", "-c", f'"$0" "$1" "$2" & wait', DASH, str(listen), CONV],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=env,
    )
    try:
        wait_for(lambda: len(stub.requests("/wake/listen")) >= 1, 10, "the listener's first request")
        scripts = [p for p in descendants_of(parent.pid) if b"a2a-agy-listen" in cmdline_of(p)]
        assert scripts, "the listener is a child of the scratch parent"
        parent.send_signal(signal.SIGKILL)
        wait_for(lambda: not any(pid_alive(p) for p in scripts), 15, "the listener to notice its parent is gone")
    finally:
        kill_quietly(parent)


def test_the_listener_does_not_start_when_its_owner_is_not_alive(listen, stub, hook_env):
    dead = subprocess.Popen(["true"])
    dead.wait()
    r = quiet(run_script(listen, [CONV], env=env_for(hook_env, stub.url, A2A_OWNER_PID=str(dead.pid))))
    assert r.stdout == "" and stub.requests() == []


def test_a_sigterm_ends_the_listener_with_exit_0_and_no_output(listen, stub, hook_env):
    stub.script("/wake/listen", Reply(408, delay=20))
    proc = start_script(listen, [CONV], env=env_for(hook_env, stub.url, A2A_ROUND_S="60"))
    try:
        wait_for(lambda: len(stub.requests("/wake/listen")) >= 1, 10, "the first request")
        proc.send_signal(signal.SIGTERM)
        out, err = proc.communicate(timeout=10)
    finally:
        kill_quietly(proc)
    assert proc.returncode == 0 and out == "" and err == ""
