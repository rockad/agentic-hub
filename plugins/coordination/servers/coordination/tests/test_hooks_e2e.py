"""S1-CLAUDE against the real S1 server: `bin/a2a-register`, `bin/a2a-listen` and `bin/a2a-pending`,
run under dash as hooks run them, against the real app (`build_server_app`, the real middleware over
the SQL key store, the real service layer, the real listener table) on a real socket and a real
Postgres (the pinned image; skipped without Docker like the rest of the suite). The key is a
throwaway one made by the test fixtures.

This is the "against the S1 server" half of the acceptance in the plan: 200 prints the stub and exits
2, 408 loops, 409 leaves silently, 401, 403 and 410 write the marker and exit 2 once, the
`410 unregistered` retry rides out the registration race (BP7), the owner watch posts the end.
What it cannot show is Claude Code itself: the live checks are listed in docs/specs/claude-hooks.md.
"""

from __future__ import annotations

import io
import json
import os
import signal
import subprocess
import time

import httpx
from auth_helpers import bearer
from hook_helpers import (
    SID,
    base_env,
    hook_json,
    kill_quietly,
    make_key_file,
    plugin_file,
    run_script,
    start_script,
    wait_for,
)
from mcp_helpers import CARD_AGY, CARD_CLAUDE, H_AGY, local_caller
from test_wake_e2e import served  # noqa: F401  (fixture: a real server on a real socket)
from wake_helpers import message

from coordination.cli import main as admin_cli

import pytest

SID2 = "5b7e1a90-0000-4000-8000-00000000beef"


def wake_text(n: int) -> str:
    return f"[a2a] {n} pending. Call a2a_inbox.\n"


def stopped_text(code: int) -> str:
    return f"[a2a] wake listener stopped: the server answered {code}. Check the coordination server and the API key.\n"


@pytest.fixture
def scripts():
    return {name: plugin_file(f"bin/{name}") for name in ("a2a-register", "a2a-listen", "a2a-pending")}


@pytest.fixture
def real(served, tmp_path):
    """Environment factory for hook runs against the real server, with the fixture's own claude key."""
    (tmp_path / "home").mkdir()
    key_file, key = make_key_file(tmp_path, served.env.keys.claude)

    def make(**extra: str) -> dict[str, str]:
        extra.setdefault("A2A_CARD", CARD_CLAUDE)
        return base_env(tmp_path, served.url, key_file, **extra)

    make.key = key  # type: ignore[attr-defined]
    make.key_file = key_file  # type: ignore[attr-defined]
    make.state = tmp_path / "state"  # type: ignore[attr-defined]
    make.tmp = tmp_path  # type: ignore[attr-defined]
    make.served = served  # type: ignore[attr-defined]
    return make


def register(scripts, real, sid: str = SID, **hook_extra) -> str:
    r = run_script(
        scripts["a2a-register"], ["start"], stdin=hook_json("SessionStart", sid=sid, source="startup", **hook_extra), env=real()
    )
    assert r.returncode == 0 and r.stderr == "", r
    out = json.loads(r.stdout)["hookSpecificOutput"]
    assert out["hookEventName"] == "SessionStart"
    text = out["additionalContext"]
    assert "A2A_API_KEY" not in text
    prefix, suffix = "[a2a] Your session handle is ", ". Call a2a_hello with it before other a2a_ tools."
    assert text.startswith(prefix) and suffix in text
    return text[len(prefix) : text.index(suffix)]


def sessions(real, **params) -> list[dict]:
    r = httpx.get(f"{real.served.url}/sessions", params=params, headers=bearer(real.key), timeout=10)
    assert r.status_code == 200, r.text
    return r.json()["sessions"]


def send_task(real, to_handle: str, text: str = "please look at this") -> None:
    served = real.served
    service = served.app.state.service
    sender = local_caller(CARD_AGY, H_AGY, key_id="feedfeed")
    meta = {"coord": {"to": to_handle}}
    served.on_server(service.send_message(sender, CARD_CLAUDE, message(text), metadata=meta))


def table(real):
    return real.served.app.state.wake.table


def wait_listening(real, handle: str, timeout: float = 15) -> None:
    wait_for(lambda: table(real).is_listening(handle), timeout, f"{handle} to be parked")


STOP = hook_json("Stop")


# ================================================ registration ===================================


def test_register_start_registers_through_the_real_route_and_the_handle_is_the_servers(scripts, real):
    handle = register(scripts, real, session_title="e2e-one")
    assert handle == f"{CARD_CLAUDE}/e2e-one~{SID[:8]}"
    (row,) = sessions(real, handle=handle)
    assert row["handle"] == handle and row["liveness"] in ("registered", "active")


def test_an_unnamed_session_gets_the_sid8_default_name(scripts, real):
    handle = register(scripts, real)
    assert handle == f"{CARD_CLAUDE}/{SID[:8]}~{SID[:8]}"  # decided Z17, reading B


def test_registering_again_is_idempotent_and_a_resume_keeps_the_handle(scripts, real):
    first = register(scripts, real, session_title="again")
    second = register(scripts, real, session_title="again")
    assert first == second
    assert len(sessions(real)) == 1
    assert register(scripts, real, sid=SID2, session_title="again") != first, "an equal name still gets its own ~sid8"


def test_a_late_name_becomes_an_alias_and_the_handle_does_not_change(scripts, real):
    unnamed = register(scripts, real)
    named = register(scripts, real, session_title="late-name")
    assert named == unnamed
    assert sessions(real, handle=unnamed)[0]["aliases"] == ["late-name"]


def test_register_end_ends_the_session_on_the_server(scripts, real):
    handle = register(scripts, real, session_title="to-end")
    r = run_script(scripts["a2a-register"], ["end"], stdin=hook_json("SessionEnd", reason="other"), env=real())
    assert r.returncode == 0 and r.stdout == ""
    assert sessions(real, handle=handle) == [], "a live-only listing no longer shows it"
    (row,) = sessions(real, handle=handle, include_ended="1")
    assert row["liveness"] == "ended"
    # a resume revives it under the same handle (Z17)
    assert register(scripts, real, session_title="to-end") == handle
    assert sessions(real, handle=handle)[0]["liveness"] in ("registered", "active")


def test_a_key_of_another_card_cannot_register_a_claude_session(scripts, real):
    r = run_script(
        scripts["a2a-register"], ["start"], stdin=hook_json("SessionStart"), env=real(A2A_CARD=CARD_AGY)
    )
    assert r.returncode == 0 and r.stdout == "" and r.stderr == "", "403 wrong_card: nothing is printed"
    assert sessions(real) == []


# =============================================== the idle wake ===================================


def test_a_task_wakes_the_parked_listener_with_the_constant_stub_and_exit_2(scripts, real):
    handle = register(scripts, real, session_title="wake-me")
    proc = start_script(scripts["a2a-listen"], stdin=STOP, env=real(CLAUDE_PID=str(os.getpid())))
    try:
        wait_listening(real, handle)
        assert sessions(real, handle=handle)[0]["liveness"] == "listening"
        t0 = time.monotonic()
        send_task(real, handle, "a body that must never reach the wake line")
        out, err = proc.communicate(timeout=15)
        took = time.monotonic() - t0
    finally:
        kill_quietly(proc)
    assert proc.returncode == 2
    assert err == wake_text(1) and out == ""
    assert "body that must never" not in err
    assert took < 5, f"send to exit 2 took {took:.1f} s (the live target is under 10 s from release to turn start)"


def test_408_rounds_loop_against_the_real_server_until_a_task_arrives(scripts, real):
    handle = register(scripts, real, session_title="rounds")
    proc = start_script(scripts["a2a-listen"], stdin=STOP, env=real(A2A_ROUND_S="1", CLAUDE_PID=str(os.getpid())))
    try:
        wait_listening(real, handle)
        time.sleep(3.5)  # at least two 408 rounds
        assert proc.poll() is None
        wait_for(lambda: table(real).is_listening(handle), 5, "the listener to be parked again after a round")
        send_task(real, handle)
        out, err = proc.communicate(timeout=15)
    finally:
        kill_quietly(proc)
    assert proc.returncode == 2 and err == wake_text(1)


def test_a_newer_listener_supersedes_the_older_one_which_exits_0_silently(scripts, real):
    handle = register(scripts, real, session_title="newest")
    env = real(CLAUDE_PID=str(os.getpid()))
    old = start_script(scripts["a2a-listen"], stdin=STOP, env=env)
    try:
        wait_listening(real, handle)
        new = start_script(scripts["a2a-listen"], stdin=hook_json("UserPromptSubmit"), env=env)
        try:
            out, err = old.communicate(timeout=10)
            assert old.returncode == 0 and out == "" and err == "", "409 superseded: silent"
            wait_listening(real, handle)
            assert new.poll() is None
            send_task(real, handle)
            out, err = new.communicate(timeout=15)
            assert new.returncode == 2 and err == wake_text(1)
        finally:
            kill_quietly(new)
    finally:
        kill_quietly(old)


def test_410_ended_by_the_server_wakes_once_with_the_notice_then_is_silent(scripts, real):
    handle = register(scripts, real, session_title="ended-elsewhere")
    env = real(CLAUDE_PID=str(os.getpid()))
    proc = start_script(scripts["a2a-listen"], stdin=STOP, env=env)
    try:
        wait_listening(real, handle)
        r = httpx.post(f"{real.served.url}/sessions/end", json={"handle": handle}, headers=bearer(real.key), timeout=10)
        assert r.status_code == 200 and r.json()["listeners_closed"] == 1
        out, err = proc.communicate(timeout=10)
    finally:
        kill_quietly(proc)
    assert proc.returncode == 2 and err == stopped_text(410) and out == ""
    again = run_script(scripts["a2a-listen"], stdin=STOP, env=env)
    assert again.returncode == 0 and again.stderr == "", "the second occurrence is silent"


def test_a_listener_closed_by_the_end_hook_of_its_own_session_leaves_silently(scripts, real):
    """The /clear flow: SessionEnd of the old session runs `a2a-register end`; the old listener gets
    410 from the server and must not wake the session that is running in the same process now."""
    handle = register(scripts, real, session_title="cleared")
    env = real(CLAUDE_PID=str(os.getpid()))
    proc = start_script(scripts["a2a-listen"], stdin=STOP, env=env)
    try:
        wait_listening(real, handle)
        ended = run_script(scripts["a2a-register"], ["end"], stdin=hook_json("SessionEnd", reason="clear"), env=env)
        assert ended.returncode == 0
        out, err = proc.communicate(timeout=10)
    finally:
        kill_quietly(proc)
    assert proc.returncode == 0 and err == "" and out == ""


def test_410_unregistered_is_retried_until_the_parallel_registration_lands(scripts, real):
    """BP7: SessionStart runs the registration and the listener hooks in parallel, and the first park
    can come first (SP2 C7: about 2 s ahead in 5 of 5 sessions). The listener starts before the
    session exists, gets 410 unregistered, retries, and parks once the registration is in."""
    env = real(CLAUDE_PID=str(os.getpid()))
    proc = start_script(scripts["a2a-listen"], stdin=hook_json("SessionStart", source="startup"), env=env)
    try:
        time.sleep(2.2)
        assert proc.poll() is None, "410 unregistered inside the first 15 s is not final"
        handle = register(scripts, real, session_title="late-registration")
        wait_listening(real, handle, 10)
        send_task(real, handle)
        out, err = proc.communicate(timeout=15)
    finally:
        kill_quietly(proc)
    assert proc.returncode == 2 and err == wake_text(1)


def test_410_unregistered_that_never_resolves_is_final_after_the_window(scripts, real):
    r = run_script(scripts["a2a-listen"], stdin=hook_json("SessionStart", source="startup"), env=real(A2A_410_RETRY_S="2", CLAUDE_PID=str(os.getpid())), timeout=30)
    assert r.returncode == 2 and r.stderr == stopped_text(410)


def test_an_unknown_key_is_401_and_a_wrong_scope_key_is_403_each_told_once(scripts, real):
    register(scripts, real)
    # 401: a well-formed key the server does not know
    bad_file, _ = make_key_file(real.tmp / "home")
    env401 = real(A2A_KEY_FILE=str(bad_file), CLAUDE_PID=str(os.getpid()), A2A_STATE_DIR=str(real.tmp / "s401"))
    first = run_script(scripts["a2a-listen"], stdin=STOP, env=env401)
    assert first.returncode == 2 and first.stderr == stopped_text(401)
    second = run_script(scripts["a2a-listen"], stdin=STOP, env=env401)
    assert second.returncode == 0 and second.stderr == ""
    # 403: a remote-peer key never reaches /wake/*
    peer_file, _ = make_key_file(real.tmp / "home", real.served.env.keys.peer)
    env403 = real(A2A_KEY_FILE=str(peer_file), CLAUDE_PID=str(os.getpid()), A2A_STATE_DIR=str(real.tmp / "s403"))
    first = run_script(scripts["a2a-listen"], stdin=STOP, env=env403)
    assert first.returncode == 2 and first.stderr == stopped_text(403)
    second = run_script(scripts["a2a-listen"], stdin=STOP, env=env403)
    assert second.returncode == 0 and second.stderr == ""


def test_a_key_revoked_while_parked_ends_the_listener_with_the_403_notice(scripts, real):
    handle = register(scripts, real, session_title="revoked")
    env = real(CLAUDE_PID=str(os.getpid()))
    proc = start_script(scripts["a2a-listen"], stdin=STOP, env=env)
    try:
        wait_listening(real, handle)
        out, err = io.StringIO(), io.StringIO()
        code = admin_cli(
            ["key", "revoke", real.served.env.keys.ids["claude"]], environ={"A2A_ADMIN_SOCKET": real.served.env.config.admin_socket}, out=out, err=err
        )
        assert code == 0, (out.getvalue(), err.getvalue())
        o, e = proc.communicate(timeout=10)
    finally:
        kill_quietly(proc)
    assert proc.returncode == 2 and e == stopped_text(403)


def test_kill_9_of_the_owner_ends_the_listener_and_the_server_marks_the_session_ended(scripts, real):
    handle = register(scripts, real, session_title="owner-dies")
    parent = subprocess.Popen(["sleep", "600"])
    proc = start_script(scripts["a2a-listen"], stdin=STOP, env=real(A2A_OWNER_PID=str(parent.pid)))
    try:
        wait_listening(real, handle)
        os.kill(parent.pid, signal.SIGKILL)
        parent.wait(timeout=5)
        t0 = time.monotonic()
        out, err = proc.communicate(timeout=10)
        assert time.monotonic() - t0 < 4.5
    finally:
        kill_quietly(proc)
        kill_quietly(parent)
    assert proc.returncode == 0 and out == "" and err == ""
    wait_for(lambda: not sessions(real, handle=handle), 5, "the end post to reach the server")
    assert sessions(real, handle=handle, include_ended="1")[0]["liveness"] == "ended"
    assert not table(real).is_listening(handle)


# ============================================ the busy-session path ==============================


def test_pending_announces_once_for_a_stable_count_and_never_sends_the_prompt(scripts, real):
    handle = register(scripts, real, session_title="busy")
    prompt_hook = hook_json("UserPromptSubmit", prompt="never leaves the machine")
    env = real()
    quiet = run_script(scripts["a2a-pending"], stdin=prompt_hook, env=env)
    assert quiet.returncode == 0 and quiet.stdout == "", "nothing pending: nothing printed"
    send_task(real, handle, "first")
    send_task(real, handle, "second")
    first = run_script(scripts["a2a-pending"], stdin=prompt_hook, env=env)
    expected = {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "[a2a] 2 pending. Call a2a_inbox."}}
    assert first.returncode == 0 and json.loads(first.stdout) == expected
    again = run_script(scripts["a2a-pending"], stdin=prompt_hook, env=env)
    assert again.returncode == 0 and again.stdout == "", "the server's dedupe: a stable count is announced once"
    send_task(real, handle, "third")
    changed = run_script(scripts["a2a-pending"], stdin=prompt_hook, env=env)
    assert json.loads(changed.stdout)["hookSpecificOutput"]["additionalContext"] == "[a2a] 3 pending. Call a2a_inbox."


def test_pending_for_an_unregistered_session_is_silent_and_a_bad_key_does_not_block_the_prompt(scripts, real):
    r = run_script(scripts["a2a-pending"], stdin=hook_json("UserPromptSubmit", sid="not-registered-anywhere"), env=real())
    assert r.returncode == 0 and r.stdout == "" and r.stderr == ""
    bad_file, _ = make_key_file(real.tmp / "home")
    r = run_script(scripts["a2a-pending"], stdin=hook_json("UserPromptSubmit"), env=real(A2A_KEY_FILE=str(bad_file)))
    assert r.returncode == 0 and r.stdout == ""


def test_the_whole_hook_chain_for_one_session_registers_listens_and_ends(scripts, real):
    """SessionStart (register), a listener, a prompt (pending), a wake, SessionEnd: the order Claude
    Code runs them in, minus Claude Code."""
    handle = register(scripts, real, session_title="chain")
    proc = start_script(scripts["a2a-listen"], stdin=hook_json("SessionStart", source="startup"), env=real(CLAUDE_PID=str(os.getpid())))
    try:
        wait_listening(real, handle)
        send_task(real, handle)
        out, err = proc.communicate(timeout=15)
        assert proc.returncode == 2 and err == wake_text(1)
    finally:
        kill_quietly(proc)
    # the woken turn is a prompt: the pending hook sees the task, the model reads it by a2a_inbox
    shown = run_script(scripts["a2a-pending"], stdin=hook_json("UserPromptSubmit"), env=real())
    assert "[a2a] 1 pending. Call a2a_inbox." in shown.stdout
    end = run_script(scripts["a2a-register"], ["end"], stdin=hook_json("SessionEnd"), env=real())
    assert end.returncode == 0
    assert sessions(real, handle=handle) == []
