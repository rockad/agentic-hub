"""S1-CLAUDE, static checks of the shipped files: `claude/hooks.json` (the Claude Code plugin hooks
format, scripts referenced through `${CLAUDE_PLUGIN_ROOT}`) and the three scripts (`shellcheck` clean,
`dash -n` clean, executable, POSIX sh). No Docker, no network.

The files live outside `src/` and `tests/`; each test skips when its file is absent (the Docker image
build runs the suite with only those two directories).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess

import pytest
from hook_helpers import DASH, plugin_file

SCRIPTS = ("a2a-register", "a2a-listen", "a2a-pending")
TIMEOUT_WEEK = 604800


@pytest.fixture(scope="module")
def hooks():
    return json.loads(plugin_file("claude/hooks.json").read_text())


def entries(hooks, event):
    return [h for group in hooks["hooks"][event] for h in group["hooks"]]


def test_hooks_json_has_the_plugin_hooks_shape_and_exactly_the_four_claude_events(hooks):
    assert set(hooks) <= {"description", "hooks"}
    assert set(hooks["hooks"]) == {"SessionStart", "Stop", "UserPromptSubmit", "SessionEnd"}
    for event, groups in hooks["hooks"].items():
        assert isinstance(groups, list) and groups
        for group in groups:
            assert set(group) <= {"matcher", "hooks"}, (event, group)
            for h in group["hooks"]:
                assert h["type"] == "command", "BP5: a command hook, not an http hook"
                assert isinstance(h["timeout"], int) and h["timeout"] > 0


def test_every_command_goes_through_claude_plugin_root_to_a_script_that_exists_and_is_executable(hooks):
    commands = [h["command"] for event in hooks["hooks"] for h in entries(hooks, event)]
    assert commands
    for command in commands:
        m = re.fullmatch(r'"\$\{CLAUDE_PLUGIN_ROOT\}/bin/(a2a-[a-z]+)"( (start|end))?', command)
        assert m, command
        assert m.group(1) in SCRIPTS
        script = plugin_file(f"bin/{m.group(1)}")
        assert os.access(script, os.X_OK), f"{script} is not executable"
    text = json.dumps(hooks)
    assert "/home/" not in text and "~/" not in text and "/Users/" not in text, "no absolute or home path"


def test_session_start_registers_first_on_four_sources_and_arms_the_listener_on_three(hooks):
    first, second = hooks["hooks"]["SessionStart"]
    assert first["matcher"] == "startup|resume|clear|compact"
    (reg,) = first["hooks"]
    assert reg["command"].endswith('/bin/a2a-register" start') and reg["timeout"] == 10 and not reg.get("asyncRewake")
    # `compact` keeps the session id and its listener; `clear` is a new session id and needs its own
    assert second["matcher"] == "startup|resume|clear"
    (listener,) = second["hooks"]
    assert listener["command"].endswith('/bin/a2a-listen"') and listener["asyncRewake"] is True and listener["timeout"] == TIMEOUT_WEEK


def test_stop_and_user_prompt_submit_arm_the_listener_and_the_prompt_hook_reports_the_count_first(hooks):
    (stop,) = entries(hooks, "Stop")
    assert stop["command"].endswith('/bin/a2a-listen"') and stop["asyncRewake"] is True and stop["timeout"] == TIMEOUT_WEEK
    pending, rearm = entries(hooks, "UserPromptSubmit")
    # BP5: the command hook a2a-pending (curl --max-time 2 inside), synchronous
    assert pending["command"].endswith('/bin/a2a-pending"') and not pending.get("asyncRewake") and pending["timeout"] == 5
    # BP2, BP3, D39: re-arm after Esc (Stop does not fire after Esc)
    assert rearm["command"].endswith('/bin/a2a-listen"') and rearm["asyncRewake"] is True and rearm["timeout"] == TIMEOUT_WEEK


def test_session_end_ends_the_session_within_the_2_second_budget(hooks):
    (end,) = entries(hooks, "SessionEnd")
    assert end["command"].endswith('/bin/a2a-register" end') and end["timeout"] == 2


def test_only_the_listener_entries_are_asyncrewake(hooks):
    rewake = [h["command"] for event in hooks["hooks"] for h in entries(hooks, event) if h.get("asyncRewake")]
    assert len(rewake) == 3 and all(c.endswith('/bin/a2a-listen"') for c in rewake)


@pytest.mark.parametrize("name", SCRIPTS)
def test_script_is_posix_sh_with_a_sh_shebang_and_executable(name):
    path = plugin_file(f"bin/{name}")
    assert path.read_text().startswith("#!/bin/sh\n")
    assert os.access(path, os.X_OK)


@pytest.mark.parametrize("name", SCRIPTS)
def test_script_parses_under_dash(name):
    path = plugin_file(f"bin/{name}")
    r = subprocess.run([DASH, "-n", str(path)], capture_output=True, text=True, check=False)
    assert r.returncode == 0, r.stderr


@pytest.mark.parametrize("name", SCRIPTS)
def test_script_is_shellcheck_clean(name):
    if shutil.which("shellcheck") is None:
        pytest.skip("shellcheck is not installed")
    path = plugin_file(f"bin/{name}")
    r = subprocess.run(["shellcheck", "-s", "sh", str(path)], capture_output=True, text=True, check=False)
    assert r.returncode == 0, r.stdout + r.stderr


def code_of(name: str) -> str:
    return "\n".join(line for line in plugin_file(f"bin/{name}").read_text().splitlines() if not line.lstrip().startswith("#"))


@pytest.mark.parametrize("name", SCRIPTS)
def test_script_has_no_bashism_a_dash_run_would_trip_on(name):
    code = code_of(name)
    for bashism in ("local ", "function ", "<<<", "&>", "${!", "declare ", "read -p", "echo -e", "==", "$RANDOM", "set -o pipefail"):
        assert bashism not in code, (name, bashism)
    assert not re.search(r"^\s*source\s", code, re.M), "source (use a dot)"
    assert not re.search(r"\[\[(?!:)", code), "[[ ]] test"
    assert not re.search(r"(?<!:)\]\]", code), "[[ ]] test"


def test_the_scripts_never_put_a_key_on_a_command_line():
    """Every curl call takes its header from `-K -` (stdin): no `-H "Authorization` and no
    `--header` with the key anywhere, and the key variable is never exported."""
    for name in SCRIPTS:
        text = plugin_file(f"bin/{name}").read_text()
        code = code_of(name)
        assert not re.search(r"-H\s+['\"]?Authorization", code), name
        assert "--header" not in code, name
        assert not re.search(r"\bexport\b", code), name
        assert "unset A2A_API_KEY" in code, name
        for call in re.findall(r"curl[^\n]*\n(?:[^\n]*\\\n)*[^\n]*", text):
            if "curl -q" in call:
                assert "-K -" in call or "-K -" in text[text.index(call) : text.index(call) + 900], call
