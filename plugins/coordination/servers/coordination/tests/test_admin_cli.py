"""`a2a-coord` admin commands, CLI side (S1-ADMIN): the real-terminal rules, the typed phrase, what is
printed and what is not. The socket is a fake that records calls, so every "nothing happened"
assertion is "the command never reached the server". The real pty runs are in `test_admin_pty.py`."""

from __future__ import annotations

import io
import json

import pytest

from admin_helpers import FakeClient, FakeTerminal, factory
from coordination.admin.protocol import AdminError
from coordination.cli import build_parser, main
from coordination.cli.tty import agent_markers

TASK = "0f1e2d3c-4b5a-4968-8776-655443abcdef"
PHRASE = "release abcdef"
SECRET_TOKEN = "a2ak_dev_0a1b2c3d_" + "S" * 43

KEY_REPLY = {
    "key_id": "0a1b2c3d", "status": "active", "scope": "local-harness", "env": "dev", "owner": "claude-code@box",
    "cards_allowed": None, "tailnet_node": "mac", "created_at": "2026-11-16T09:00:00+00:00",
    "expires_at": "2027-02-14T09:00:00+00:00", "last_used_at": None, "revoked_at": None, "token": SECRET_TOKEN,
}  # fmt: skip
HELD = {
    "task_id": TASK, "peer": "peer:acme", "card": "claude-code@box", "to_handle": None,
    "received_at": "2026-11-16T09:00:00+00:00", "expires_at": None, "size_bytes": 11,
    "frame": {
        "untrusted": True, "tasks": [{"messages": [{"message_id": "m1", "role": "ROLE_USER", "parts": [
            {"type": "text", "text": "hello \x1b[31mred\x07 world"}]}]}],
    },
}  # fmt: skip


def run_cli(argv, *, terminal=None, client=None, environ=None):
    client = client if client is not None else FakeClient()
    out, err = io.StringIO(), io.StringIO()
    code = main(
        argv,
        environ=environ if environ is not None else {},
        terminal=terminal if terminal is not None else FakeTerminal(),
        client_factory=factory(client),
        out=out,
        err=err,
    )
    return code, out.getvalue(), err.getvalue(), client


COMMANDS_NEEDING_A_TERMINAL = [
    ["key", "create", "--scope", "local-harness", "--agent", "claude-code@box", "--expires", "30d"],
    ["key", "rotate", "0a1b2c3d"],
    ["review", "show", TASK],
    ["review", "release", TASK],
    ["review", "deny", TASK],
]


@pytest.mark.parametrize("argv", COMMANDS_NEEDING_A_TERMINAL, ids=lambda a: " ".join(a[:2]))
@pytest.mark.parametrize("stdin,stdout", [(False, True), (True, False), (False, False)])
def test_commands_refuse_without_a_terminal_on_stdin_and_stdout(argv, stdin, stdout):
    code, out, err, client = run_cli(argv, terminal=FakeTerminal(stdin=stdin, stdout=stdout, typed=PHRASE))
    assert code == 1 and "terminal" in err and "-it" in err
    assert client.calls == []  # it never reached the server
    assert out == "" and SECRET_TOKEN not in out + err


@pytest.mark.parametrize("argv", COMMANDS_NEEDING_A_TERMINAL, ids=lambda a: " ".join(a[:2]))
@pytest.mark.parametrize("marker", ["CLAUDE_CODE_SESSION_ATTENDED", "CLAUDECODE", "CLAUDE_PID", "CI", "ANTIGRAVITY_SESSION", "AGY_SESSION_ID"])
def test_commands_refuse_when_an_agent_session_marker_is_set(argv, marker):
    # Whatever the value, even "0" or empty: the marker's presence is the signal.
    for value in ("1", "0", ""):
        code, out, err, client = run_cli(argv, terminal=FakeTerminal(typed=PHRASE), environ={marker: value, "PATH": "/bin"})
        assert code == 1 and marker in err and "agent-session" in err
        assert client.calls == [] and out == ""
        assert "PATH" not in err and "/bin" not in err  # names only, never other values


def test_markers_are_found_by_name_prefix_and_ordinary_variables_are_not_markers():
    env = {"CLAUDE_CODE_X": "1", "CI": "true", "ANTIGRAVITY_Y": "1", "AGY_Z": "1", "HOME": "/h", "CIRCLE": "x", "LANG": "C"}
    assert agent_markers(env) == ["AGY_Z", "ANTIGRAVITY_Y", "CI", "CLAUDE_CODE_X"]
    assert agent_markers({"HOME": "/h", "PATH": "/bin", "AGENT": "x", "MY_CLAUDE": "x"}) == []


def test_read_only_commands_work_without_a_terminal_and_never_print_a_secret():
    client = FakeClient(replies={"key.list": {"keys": [{k: v for k, v in KEY_REPLY.items() if k != "token"}]}})
    code, out, err, _ = run_cli(["key", "list"], terminal=FakeTerminal(stdin=False, stdout=False), client=client)
    assert code == 0 and "0a1b2c3d" in out and "claude-code@box" in out and "S" * 43 not in out + err
    assert run_cli(["key", "list", "--json"], terminal=FakeTerminal(stdin=False, stdout=False), client=client)[0] == 0
    held = FakeClient(replies={"review.list": {"held": [{k: HELD[k] for k in HELD if k != "frame"}]}})
    code, out, _, _ = run_cli(["review"], terminal=FakeTerminal(stdin=False, stdout=False), client=held)
    assert code == 0 and TASK in out and "peer:acme" in out and "hello" not in out  # no body in the list
    assert held.commands() == ["review.list"]
    code, *_ = run_cli(["review", "list"], terminal=FakeTerminal(stdin=False, stdout=False), client=held)
    assert code == 0


def test_key_revoke_needs_no_terminal_and_reports_what_it_closed():
    client = FakeClient(replies={"key.revoke": {"key_id": "0a1b2c3d", "revoked": True, "closed": {"mcp": 2}, "hook_failures": [], "audited": True}})
    code, out, _, _ = run_cli(["key", "revoke", "0a1b2c3d"], terminal=FakeTerminal(stdin=False, stdout=False), client=client)
    assert code == 0 and "revoked" in out and "mcp 2" in out
    client = FakeClient(replies={"key.revoke": {"key_id": "0a1b2c3d", "revoked": True, "closed": {}, "hook_failures": ["wake"], "audited": True}})
    code, _, err, _ = run_cli(["key", "revoke", "0a1b2c3d"], client=client)
    assert code == 1 and "wake" in err


def test_key_create_prints_the_secret_once_to_the_terminal_and_sends_the_options():
    client = FakeClient(replies={"key.create": KEY_REPLY})
    code, out, err, client = run_cli(
        ["key", "create", "--scope", "local-harness", "--agent", "claude-code@box", "--tailnet-node", "mac", "--expires", "90d"],
        client=client,
    )
    assert code == 0 and out.count(SECRET_TOKEN) == 1 and SECRET_TOKEN not in err
    assert "only time" in out
    assert client.calls == [("key.create", {"scope": "local-harness", "agent": "claude-code@box", "tailnet_node": "mac", "cards": None, "expires": "90d"})]


def test_key_create_cards_may_be_repeated_or_comma_separated():
    client = FakeClient(replies={"key.create": {**KEY_REPLY, "scope": "remote-peer", "cards_allowed": ["a@b", "c@d"]}})
    run_cli(["key", "create", "--scope", "remote-peer", "--agent", "peer", "--cards", "a@b,c@d", "--cards", "e@f", "--expires", "1d"], client=client)
    assert client.calls[0][1]["cards"] == ["a@b", "c@d", "e@f"]


def test_key_create_requires_expires_and_has_no_tailnet_login_or_yes_option():
    for argv in (
        ["key", "create", "--scope", "local-harness", "--agent", "claude-code@box"],  # no --expires
        ["key", "create", "--scope", "admin", "--agent", "x", "--expires", "1d"],  # no admin scope
        ["key", "create", "--scope", "local-harness", "--agent", "x", "--expires", "1d", "--tailnet-login", "a@b"],
        ["key", "create", "--scope", "local-harness", "--agent", "x", "--expires", "1d", "--yes"],
        ["review", "release", TASK, "--yes"],
        ["review", "release", TASK, "-y"],
        ["review", "release", "--all"],
        ["review", "release", TASK, TASK],  # one task per call
        ["review", "release"],
        ["review", "deny", "--force", TASK],
    ):
        with pytest.raises(SystemExit) as e:
            run_cli(argv)
        assert e.value.code == 2, argv


def test_no_option_of_any_command_skips_a_prompt_or_a_terminal_rule():
    """The parser has no flag that could skip the phrase or the terminal check (D19)."""
    parser = build_parser()
    flags: set[str] = set()

    def walk(p) -> None:
        for action in p._actions:  # noqa: SLF001 - reading the parser's own table is the point
            flags.update(action.option_strings)
            for sub in getattr(action, "choices", None) or {}:
                walk(action.choices[sub]) if hasattr(action.choices, "get") else None

    walk(parser)
    assert {"--scope", "--expires", "--grace", "--json", "--tailnet-node", "--cards"} <= flags  # the walk reached the sub-commands
    for banned in ("--yes", "-y", "--force", "--all", "--no-confirm", "--batch", "--skip", "--non-interactive", "--assume-yes", "--tailnet-login"):
        assert banned not in flags


def test_release_with_the_right_phrase_sends_it_and_names_the_task():
    client = FakeClient(replies={"review.show": HELD, "review.release": {"task_id": TASK, "state": "TASK_STATE_SUBMITTED", "released": True}})
    term = FakeTerminal(typed=PHRASE)
    code, out, err, client = run_cli(["review", "release", TASK], terminal=term, client=client)
    assert code == 0 and "released to SUBMITTED" in out and "peer:acme" in out
    assert term.prompts == [f"Type '{PHRASE}' to release this task: "]
    assert client.calls[-1] == ("review.release", {"task_id": TASK, "phrase": PHRASE})
    assert "hello" not in out  # the summary has no body


@pytest.mark.parametrize("typed", ["", "release", "release abcde", "release ABCDEF", "Release abcdef", "deny abcdef", "yes", "y", "release 000000", PHRASE + "x", None])
def test_release_with_a_wrong_phrase_does_nothing(typed):
    client = FakeClient(replies={"review.show": HELD})
    code, out, err, client = run_cli(["review", "release", TASK], terminal=FakeTerminal(typed=typed), client=client)
    assert code == 1
    assert "review.release" not in client.commands()  # the release request is never sent
    assert "released" not in out


def test_release_asks_nobody_when_there_is_no_controlling_terminal():
    client = FakeClient(replies={"review.show": HELD})
    code, _, err, client = run_cli(["review", "release", TASK], terminal=FakeTerminal(typed=None), client=client)
    assert code == 1 and "/dev/tty" in err and "review.release" not in client.commands()


def test_deny_needs_its_own_phrase_and_release_phrase_does_not_deny():
    client = FakeClient(replies={"review.show": HELD, "review.deny": {"task_id": TASK, "state": "TASK_STATE_REJECTED", "denied": True}})
    code, *_ = run_cli(["review", "deny", TASK], terminal=FakeTerminal(typed=PHRASE), client=client)
    assert code == 1 and "review.deny" not in client.commands()
    code, out, _, client = run_cli(["review", "deny", TASK], terminal=FakeTerminal(typed="deny abcdef"), client=client)
    assert code == 0 and client.calls[-1] == ("review.deny", {"task_id": TASK, "phrase": "deny abcdef"})


def test_review_show_prints_the_body_framed_as_untrusted_and_without_control_characters():
    client = FakeClient(replies={"review.show": HELD})
    code, out, err, _ = run_cli(["review", "show", TASK], client=client)
    assert code == 0 and out.startswith("UNTRUSTED DATA")
    assert "hello" in out and "world" in out and "end of untrusted data" in out
    assert "\x1b" not in out and "\x07" not in out


def test_server_errors_are_shown_with_their_code_and_unreachable_is_exit_2():
    client = FakeClient(replies={"key.list": AdminError("refused", "nope")})
    code, _, err, _ = run_cli(["key", "list"], client=client)
    assert code == 1 and "nope" in err and "[refused]" in err
    client = FakeClient(replies={"status": AdminError("unavailable", "the database did not answer")})
    assert run_cli(["status"], client=client)[0] == 2
    from coordination.cli.client import Unreachable

    class Down:
        def call(self, *a, **k):
            raise Unreachable("no admin socket at /x; is the server running in this container?")

    code, _, err, _ = run_cli(["status"], client=Down())  # type: ignore[arg-type]
    assert code == 2 and "no admin socket" in err


def test_status_and_card_check_render_and_card_check_exit_codes():
    status = {
        "now": "2026-11-16T09:00:00+00:00", "stage": "s1", "env": "dev",
        "sessions": {"registered": 1, "active": 1, "ended": 0, "by_card": [{"card": "claude-code@box", "registered": 1, "active": 1}], "mcp_bound": 1},
        "listeners": {"parked": None},
        "pending": {"submitted": 2, "card_queue": 1, "held": 1, "working": 0, "by_card": [{"card": "claude-code@box", "submitted": 2}]},
        "budgets": {"wake_per_hour_limit": 20, "window_minutes": 60, "used": []},
        "stale_offers": {"reoffer_max": 5, "count": 0, "tasks": []},
        "schema": {"coord_schema_version": 2, "sdk_revision": "abc"}, "backup": {"dump_age_h": None, "stale": False},
    }  # fmt: skip
    code, out, _, _ = run_cli(["status"], client=FakeClient(replies={"status": status}))
    assert code == 0 and "listeners:    null parked" in out and "schema:       coordination v2" in out and "[STALE]" not in out
    stale_status = {**status, "backup": {"dump_age_h": 40.0, "stale": True}}
    code, out, _, _ = run_cli(["status"], client=FakeClient(replies={"status": stale_status}))
    assert code == 0 and "last good dump 40.0 h ago" in out and "[STALE]" in out
    ok = {"ok": True, "problems": [], "notes": ["claude-code@box: no live session"], "cards": [{"card_id": "claude-code@box", "in_table": True, "live_sessions": 0}]}
    bad = {**ok, "ok": False, "problems": ["claude-code@box: x"]}
    assert run_cli(["card", "check"], client=FakeClient(replies={"card.check": ok}))[0] == 0
    code, out, _, _ = run_cli(["card", "check"], client=FakeClient(replies={"card.check": bad}))
    assert code == 1 and "PROBLEM" in out
    code, out, _, _ = run_cli(["card", "check", "--json"], client=FakeClient(replies={"card.check": ok}))
    assert code == 0 and json.loads(out)["ok"] is True


def test_expose_check_and_admin_apply_say_they_are_not_available_and_exit_2():
    for argv, owner in ((["expose", "check"], "S3-EXPOSE-CHECK"), (["admin-apply"], "GL-IMPORT")):
        code, out, err, client = run_cli(argv)
        assert code == 2 and "not available at this stage" in err and owner in err
        assert out == "" and client.calls == []


def test_a_bad_socket_variable_is_reported():
    code, _, err, _ = run_cli(["status"], environ={"A2A_ENV": "prod"})
    assert code == 2 and "A2A_ENV" in err


def test_the_socket_path_comes_from_the_configuration():
    seen: list[str] = []

    def spy(path: str) -> FakeClient:
        seen.append(path)
        return FakeClient(replies={"key.list": {"keys": []}})

    main(["key", "list"], environ={"A2A_ADMIN_SOCKET": "/tmp/x.sock"}, terminal=FakeTerminal(), client_factory=spy, out=io.StringIO(), err=io.StringIO())
    main(["key", "list"], environ={}, terminal=FakeTerminal(), client_factory=spy, out=io.StringIO(), err=io.StringIO())
    assert seen == ["/tmp/x.sock", "/run/a2a/admin.sock"]


def test_help_lists_every_command():
    out = io.StringIO()
    with pytest.raises(SystemExit):
        main(["--help"], environ={}, out=out)
    text = build_parser().format_help()
    for word in ("key", "review", "status", "card", "expose", "admin-apply", "db"):
        assert word in text
