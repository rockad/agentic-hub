"""WS1 (decision Z21 item 5): `bin/a2a-lib.sh`, the settings reader every hook script sources.

The file `${A2A_SETTINGS_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/a2a-coord/settings}` is plain `KEY=value`
lines, read line by line and never sourced, evaluated or expanded. These tests run `a2a_load_config`
under dash and check, for each rule, what the shell ends up holding:

- the file is used when the environment has nothing, and the environment wins when it has something;
- an unknown name, a comment, a blank line and a line without `=` are ignored;
- `$(...)`, backticks, `$VAR` and `;cmd` in a value are plain text: nothing is run and nothing is created;
- CRLF, quotes (one matching pair only), a value over 512 bytes and a control character;
- a missing, unreadable or directory-valued file is ignored, silently, with status 0;
- no output ever, no external command (an empty PATH works), no variable left behind;
- end to end: a hook script picks its server URL, key file and card from the file.

No Docker and no agy. The library is outside `src/` and `tests/`, which the image build runs alone,
so every test skips when it is absent.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import agy_hook_helpers as agy
import hook_helpers as hh
import pytest

pytestmark = pytest.mark.hooks
from conftest import PLUGIN_DIR
from hook_helpers import hook_env, stub  # noqa: F401  (fixtures)

LIB = PLUGIN_DIR / "bin" / "a2a-lib.sh"
NAMES = ("A2A_SERVER_URL", "A2A_CARD", "A2A_AGY_CARD", "A2A_KEY_FILE", "A2A_AGY_KEY_FILE")

# The driver: source the lib, call the function, print the status and one line per name. `eval` is
# here, in the test, over a fixed list of names; the lib has none.
DRIVER = r"""
. "$1"
a2a_load_config
echo "rc=$?"
for n in A2A_SERVER_URL A2A_CARD A2A_AGY_CARD A2A_KEY_FILE A2A_AGY_KEY_FILE; do
  eval "if [ \"\${$n+x}\" ]; then printf '%s=<%s>\n' $n \"\${$n}\"; else printf '%s unset\n' $n; fi"
done
"""


@pytest.fixture(autouse=True)
def _need_lib():
    if not LIB.is_file():
        pytest.skip(f"{LIB} is not present (the image build runs the suite with only src/ and tests/)")
    if shutil.which("dash") is None:
        pytest.skip("dash is not installed")


def run_lib(tmp_path: Path, content: bytes | None, *, env: dict[str, str] | None = None, driver: str = DRIVER, path: str | None = None):
    """Run the driver under dash with the file `content` as the settings file. Returns (stdout, stderr,
    status, {name: value or None})."""
    cfg = tmp_path / "config"
    if content is not None:
        cfg.write_bytes(content)
    scratch = tmp_path / "cwd"
    scratch.mkdir(exist_ok=True)
    full = {"PATH": path if path is not None else os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(tmp_path / "home"), "A2A_SETTINGS_FILE": str(cfg)}
    full.update(env or {})
    proc = subprocess.run(
        [shutil.which("dash") or "dash", "-c", driver, "dash", str(LIB)],
        capture_output=True,
        text=True,
        env=full,
        cwd=scratch,
        timeout=30,
        check=False,
    )
    values: dict[str, str | None] = {}
    for line in proc.stdout.splitlines():
        if line.endswith(" unset"):
            values[line[: -len(" unset")]] = None
        elif "=<" in line and line.endswith(">"):
            name, _, rest = line.partition("=<")
            values[name] = rest[:-1]
    return proc.stdout, proc.stderr, proc.returncode, values


def lines(*items: str, eol: str = "\n") -> bytes:
    return "".join(item + eol for item in items).encode()


# the file is used, the environment wins ------------------------------------------------------


def test_the_file_is_used_when_the_environment_has_nothing(tmp_path):
    content = lines(
        "A2A_SERVER_URL=http://127.0.0.1:9999",
        "A2A_CARD=claude-code@box",
        "A2A_AGY_CARD=antigravity@box",
        "A2A_KEY_FILE=/k/claude",
        "A2A_AGY_KEY_FILE=/k/agy.json",
    )
    out, err, rc, values = run_lib(tmp_path, content)
    assert (rc, err) == (0, "") and "rc=0" in out
    assert values == {
        "A2A_SERVER_URL": "http://127.0.0.1:9999",
        "A2A_CARD": "claude-code@box",
        "A2A_AGY_CARD": "antigravity@box",
        "A2A_KEY_FILE": "/k/claude",
        "A2A_AGY_KEY_FILE": "/k/agy.json",
    }


def test_a_set_and_non_empty_environment_variable_wins_over_the_file(tmp_path):
    content = lines("A2A_SERVER_URL=http://file:1", "A2A_CARD=claude-code@file")
    _o, _e, _rc, values = run_lib(tmp_path, content, env={"A2A_SERVER_URL": "http://env:2"})
    assert values["A2A_SERVER_URL"] == "http://env:2"
    assert values["A2A_CARD"] == "claude-code@file", "the other name still comes from the file"


def test_an_empty_environment_variable_does_not_win(tmp_path):
    _o, _e, _rc, values = run_lib(tmp_path, lines("A2A_SERVER_URL=http://file:1"), env={"A2A_SERVER_URL": ""})
    assert values["A2A_SERVER_URL"] == "http://file:1"


def test_with_no_file_value_and_no_environment_a_name_stays_unset(tmp_path):
    _o, _e, _rc, values = run_lib(tmp_path, lines("A2A_CARD=claude-code@file"))
    assert values["A2A_SERVER_URL"] is None and values["A2A_KEY_FILE"] is None


def test_the_first_occurrence_of_a_name_wins(tmp_path):
    _o, _e, _rc, values = run_lib(tmp_path, lines("A2A_CARD=claude-code@one", "A2A_CARD=claude-code@two"))
    assert values["A2A_CARD"] == "claude-code@one"


def test_the_default_location_follows_xdg_config_home_then_home(tmp_path):
    xdg = tmp_path / "xdg" / "a2a-coord"
    xdg.mkdir(parents=True)
    (xdg / "settings").write_text("A2A_CARD=claude-code@xdg\n")
    home = tmp_path / "home" / ".config" / "a2a-coord"
    home.mkdir(parents=True)
    (home / "settings").write_text("A2A_CARD=claude-code@home\n")
    unset_file = {"A2A_SETTINGS_FILE": ""}  # an empty A2A_SETTINGS_FILE is the same as none
    _o, _e, _rc, values = run_lib(tmp_path, None, env={**unset_file, "XDG_CONFIG_HOME": str(tmp_path / "xdg")})
    assert values["A2A_CARD"] == "claude-code@xdg"
    _o, _e, _rc, values = run_lib(tmp_path, None, env=unset_file)
    assert values["A2A_CARD"] == "claude-code@home"


# lines that are ignored ----------------------------------------------------------------------


def test_unknown_names_comments_blank_lines_and_lines_without_an_equals_sign_are_ignored(tmp_path):
    content = lines(
        "",
        "# A2A_SERVER_URL=http://commented:1",
        "   # an indented comment",
        "OTHER_NAME=1",
        "A2A_API_KEY=a2ak_test_x_y",
        "A2A_CARD",
        "export A2A_CARD=claude-code@exported",
        " A2A_CARD=claude-code@indented",
        "A2A_CARD =claude-code@spaced",
        "a2a_card=claude-code@lower",
        "A2A_KEY_FILE=/k/real",
    )
    out, err, rc, values = run_lib(tmp_path, content)
    assert (rc, err) == (0, "")
    assert values == {
        "A2A_SERVER_URL": None,
        "A2A_CARD": None,
        "A2A_AGY_CARD": None,
        "A2A_KEY_FILE": "/k/real",
        "A2A_AGY_KEY_FILE": None,
    }
    assert "OTHER_NAME" not in out and "a2ak_" not in out, "a name outside the list is never set"


def test_a_name_outside_the_list_is_not_even_defined_in_the_shell(tmp_path):
    driver = DRIVER + '\nif [ "${A2A_API_KEY+x}${OTHER_NAME+x}" ]; then echo LEAK; else echo clean; fi\n'
    out, _e, _rc, _v = run_lib(tmp_path, lines("OTHER_NAME=1", "A2A_API_KEY=a2ak_test_x_y"), driver=driver)
    assert out.splitlines()[-1] == "clean"


def test_an_empty_value_is_ignored(tmp_path):
    _o, _e, _rc, values = run_lib(tmp_path, lines("A2A_CARD=", "A2A_KEY_FILE=/k"))
    assert values["A2A_CARD"] is None


def test_a_last_line_without_a_newline_is_read(tmp_path):
    _o, _e, _rc, values = run_lib(tmp_path, b"A2A_CARD=claude-code@a\nA2A_KEY_FILE=/last")
    assert values["A2A_KEY_FILE"] == "/last"


def test_a_crlf_file_gives_clean_values(tmp_path):
    content = lines("A2A_SERVER_URL=http://127.0.0.1:1", "# c", "A2A_CARD=claude-code@box", eol="\r\n")
    _o, _e, _rc, values = run_lib(tmp_path, content)
    assert values["A2A_SERVER_URL"] == "http://127.0.0.1:1"
    assert values["A2A_CARD"] == "claude-code@box"


def test_a_cr_inside_a_value_is_a_control_character_and_drops_the_line(tmp_path):
    _o, _e, _rc, values = run_lib(tmp_path, b"A2A_CARD=claude\rcode@box\n")
    assert values["A2A_CARD"] is None


# nothing is evaluated ------------------------------------------------------------------------

HOSTILE = [
    "$(touch {d}/pwned-subst)",
    "`touch {d}/pwned-tick`",
    "$HOME/x",
    "${HOME}/x",
    "$((1+1))",
    "x;touch {d}/pwned-semi",
    "x&&touch {d}/pwned-and",
    "x|touch {d}/pwned-pipe",
    "x>{d}/pwned-redirect",
    "a\\nb\\tc\\\\d",
    "~/x",
    "*",
]


@pytest.mark.parametrize("value", HOSTILE)
@pytest.mark.parametrize("quote", ["", '"', "'"])
def test_a_hostile_value_is_plain_text_and_runs_nothing(tmp_path, value, quote):
    value = value.replace("{d}", str(tmp_path))
    out, err, rc, values = run_lib(tmp_path, lines(f"A2A_CARD={quote}{value}{quote}"))
    assert (rc, err) == (0, "")
    assert values["A2A_CARD"] == value, "the characters are kept as they are"
    assert not list(tmp_path.glob("pwned-*")), "a command in a value ran"
    assert not list((tmp_path / "cwd").iterdir()), "a glob or a redirect touched the working directory"


def test_a_hostile_name_part_cannot_set_or_run_anything(tmp_path):
    content = lines("A2A_CARD$(touch %s/pwned-name)=x" % tmp_path, "$(touch %s/pwned-line)" % tmp_path)
    _o, err, rc, values = run_lib(tmp_path, content)
    assert (rc, err) == (0, "") and set(values.values()) == {None}
    assert not list(tmp_path.glob("pwned-*"))


# quotes --------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw, expected",
    [
        ('"claude-code@box"', "claude-code@box"),
        ("'claude-code@box'", "claude-code@box"),
        ('"a b  c"', "a b  c"),
        ("'$HOME `x`'", "$HOME `x`"),
        ("'\"x\"'", '"x"'),
        ('"\'x\'"', "'x'"),
        ('"a"b"', 'a"b'),  # one pair stripped, nothing else
        ('"abc', '"abc'),  # unmatched: kept
        ("abc'", "abc'"),
        ("\"abc'", "\"abc'"),  # mismatched pair: kept
        ('"', '"'),  # a lone quote is not a pair
        ('""x""', '"x"'),  # still only one pair
        ("  spaced  ", "  spaced  "),  # nothing is trimmed
    ],
)
def test_one_optional_pair_of_matching_quotes_is_removed_and_nothing_else(tmp_path, raw, expected):
    _o, _e, _rc, values = run_lib(tmp_path, lines(f"A2A_CARD={raw}"))
    assert values["A2A_CARD"] == expected


@pytest.mark.parametrize("raw", ['""', "''"])
def test_a_quoted_empty_value_is_ignored(tmp_path, raw):
    _o, _e, _rc, values = run_lib(tmp_path, lines(f"A2A_CARD={raw}"))
    assert values["A2A_CARD"] is None


# limits --------------------------------------------------------------------------------------


def test_a_value_of_512_bytes_is_kept_and_one_of_513_is_dropped(tmp_path):
    ok, too_long = "k" * 512, "k" * 513
    _o, _e, _rc, values = run_lib(tmp_path, lines(f"A2A_KEY_FILE={ok}", f"A2A_AGY_KEY_FILE={too_long}"))
    assert values["A2A_KEY_FILE"] == ok
    assert values["A2A_AGY_KEY_FILE"] is None


def test_the_length_limit_counts_a_quoted_value_without_its_quotes(tmp_path):
    _o, _e, _rc, values = run_lib(tmp_path, lines('A2A_KEY_FILE="' + "k" * 512 + '"'))
    assert values["A2A_KEY_FILE"] == "k" * 512


@pytest.mark.parametrize("char", ["\t", "\x01", "\x07", "\x1b", "\x7f"])
def test_a_value_with_a_control_character_is_dropped(tmp_path, char):
    _o, _e, rc, values = run_lib(tmp_path, f"A2A_CARD=a{char}b\nA2A_KEY_FILE=/ok\n".encode())
    assert rc == 0 and values["A2A_CARD"] is None
    assert values["A2A_KEY_FILE"] == "/ok", "the next line is still read"


def test_a_non_ascii_value_is_kept(tmp_path):
    path = "/home/алекс/k"
    _o, _e, _rc, values = run_lib(tmp_path, lines(f"A2A_KEY_FILE={path}"), env={"LC_ALL": "C.UTF-8"})
    assert values["A2A_KEY_FILE"] == path


# a file that cannot be used ------------------------------------------------------------------


def test_a_missing_file_is_ignored_silently(tmp_path):
    out, err, rc, values = run_lib(tmp_path, None)
    assert (rc, err) == (0, "") and set(values.values()) == {None}
    assert out.splitlines()[0] == "rc=0"


def test_a_directory_in_place_of_the_file_is_ignored_silently(tmp_path):
    (tmp_path / "config").mkdir()
    _o, err, rc, values = run_lib(tmp_path, None)
    assert (rc, err) == (0, "") and set(values.values()) == {None}


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads a mode-000 file")
def test_an_unreadable_file_is_ignored_silently(tmp_path):
    cfg = tmp_path / "config"
    cfg.write_text("A2A_CARD=claude-code@secret\n")
    cfg.chmod(0)
    out, err, rc, values = run_lib(tmp_path, None)
    assert (rc, err) == (0, "") and set(values.values()) == {None}
    assert out.splitlines()[0] == "rc=0"


def test_a_binary_file_does_no_harm(tmp_path):
    content = bytes(range(256)) * 8 + b"\nA2A_KEY_FILE=/after\n"
    _o, err, rc, values = run_lib(tmp_path, content)
    assert (rc, err) == (0, "") and values["A2A_KEY_FILE"] == "/after"


# the caller is never disturbed ---------------------------------------------------------------


@pytest.mark.parametrize("content", [None, lines("A2A_CARD=x"), b"\x00\xff garbage\n", lines("A2A_CARD=$(false)")])
def test_it_prints_nothing_and_returns_0_even_under_set_e_and_set_u(tmp_path, content):
    driver = 'set -eu\n. "$1"\na2a_load_config\necho survived\n'
    out, err, rc, _v = run_lib(tmp_path, content, driver=driver, env={"A2A_CARD": "claude-code@env"})
    assert (out, err, rc) == ("survived\n", "", 0)


def test_it_prints_nothing_itself(tmp_path):
    driver = '. "$1"\na2a_load_config\n'
    for content in (None, lines("A2A_CARD=x", "junk", "A2A_KEY_FILE=" + "k" * 600)):
        assert run_lib(tmp_path, content, driver=driver)[:3] == ("", "", 0)


def test_it_runs_no_external_command(tmp_path):
    """An empty PATH: only shell built-ins work, so the common path starts no process."""
    empty = tmp_path / "emptybin"
    empty.mkdir()
    out, err, rc, values = run_lib(tmp_path, lines("A2A_CARD=claude-code@box"), path=str(empty))
    assert (rc, err) == (0, "") and values["A2A_CARD"] == "claude-code@box"


def test_it_leaves_no_variable_behind_but_the_five_names(tmp_path):
    driver = '. "$1"\na2a_load_config\nset | while IFS= read -r l; do case $l in a2a_cfg_*) echo "LEFT $l";; esac; done\necho end\n'
    out, _e, _rc, _v = run_lib(tmp_path, lines("A2A_CARD=claude-code@box"), driver=driver)
    assert out == "end\n"


def test_the_lib_has_no_eval_and_no_command_substitution_of_file_data():
    code = "\n".join(line for line in LIB.read_text().splitlines() if not line.lstrip().startswith("#"))
    assert "eval" not in code and "`" not in code
    assert code.count("$(") == 1, "the one substitution is the CR character"


def test_the_lib_is_shellcheck_clean_and_parses_under_dash():
    assert subprocess.run(["dash", "-n", str(LIB)], check=False).returncode == 0
    shellcheck = shutil.which("shellcheck")
    if shellcheck is None:
        pytest.skip("shellcheck is not installed")
    proc = subprocess.run([shellcheck, "-s", "sh", "-S", "style", str(LIB)], capture_output=True, text=True, check=False)
    assert proc.returncode == 0, proc.stdout + proc.stderr


# end to end: a hook script reads the file ----------------------------------------------------


def _config_dir(home: Path) -> Path:
    path = home / ".config" / "a2a-coord"
    path.mkdir(parents=True)
    return path


def _bare_env(home: Path) -> dict[str, str]:
    """No A2A_* name in the environment: everything must come from the file."""
    return {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(home)}


def _run_relative(script_rel: str, stdin: str, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    """The way agy runs a plugin hook: `./bin/<script>` with the plugin folder as the working directory."""
    return subprocess.run([script_rel], input=stdin, capture_output=True, text=True, env=env, cwd=PLUGIN_DIR, timeout=30, check=False)


def test_a2a_agy_pending_takes_the_server_url_and_key_file_from_the_file(tmp_path):
    agy.script(agy.PENDING)
    stub = agy.start_stub()
    try:
        key = agy.throwaway_key()
        key_file = agy.write_key_file(tmp_path, key)
        (_config_dir(tmp_path) / "settings").write_text(f"# the machine's settings\nA2A_SERVER_URL={stub.url}\nA2A_AGY_KEY_FILE={key_file}\n")
        stub.pending = agy.Reply(200, agy.announce_body(4))
        result = _run_relative("./bin/a2a-agy-pending", agy.hook_input(), _bare_env(tmp_path))
        assert (result.returncode, result.stderr) == (0, "")
        assert result.stdout == agy.pending_line(4)
        (seen,) = stub.calls("/wake/pending")
        assert seen.headers["authorization"] == f"Bearer {key}"
    finally:
        stub.server.shutdown()
        stub.server.server_close()


def test_a2a_agy_pending_without_the_file_makes_no_call(tmp_path):
    """The fail-before half: the same environment without the file reaches nothing."""
    agy.script(agy.PENDING)
    stub = agy.start_stub()
    try:
        agy.write_key_file(tmp_path, agy.throwaway_key())
        stub.pending = agy.Reply(200, agy.announce_body(4))
        result = _run_relative("./bin/a2a-agy-pending", agy.hook_input(), _bare_env(tmp_path))
        assert (result.returncode, result.stdout, result.stderr) == (0, "{}\n", "")
        assert stub.seen == []
    finally:
        stub.server.shutdown()
        stub.server.server_close()


def test_a2a_agy_pending_reads_the_key_from_the_global_mcp_config_by_default(tmp_path):
    """Only the server URL comes from the file; the key file is the default `~/.gemini/config/mcp_config.json`."""
    agy.script(agy.PENDING)
    stub = agy.start_stub()
    try:
        key = agy.throwaway_key()
        (tmp_path / ".gemini" / "config").mkdir(parents=True)
        agy.write_key_file(tmp_path / ".gemini" / "config", key)
        (_config_dir(tmp_path) / "settings").write_text(f"A2A_SERVER_URL={stub.url}\n")
        stub.pending = agy.Reply(200, agy.announce_body(1))
        result = _run_relative("./bin/a2a-agy-pending", agy.hook_input(), _bare_env(tmp_path))
        assert result.stdout == agy.pending_line(1)
        assert stub.calls("/wake/pending")[0].headers["authorization"] == f"Bearer {key}"
    finally:
        stub.server.shutdown()
        stub.server.server_close()


def test_a2a_agy_pending_environment_beats_the_file(tmp_path):
    agy.script(agy.PENDING)
    stub = agy.start_stub()
    try:
        key_file = agy.write_key_file(tmp_path, agy.throwaway_key())
        (_config_dir(tmp_path) / "settings").write_text("A2A_SERVER_URL=http://127.0.0.1:1\n")
        stub.pending = agy.Reply(200, agy.announce_body(2))
        env = {**_bare_env(tmp_path), "A2A_SERVER_URL": stub.url, "A2A_AGY_KEY_FILE": str(key_file)}
        assert _run_relative("./bin/a2a-agy-pending", agy.hook_input(), env).stdout == agy.pending_line(2)
    finally:
        stub.server.shutdown()
        stub.server.server_close()


def test_a2a_agy_session_takes_url_key_file_and_card_from_the_file(tmp_path):
    agy.script(agy.SESSION)
    stub = agy.start_stub()
    try:
        key_file = agy.write_key_file(tmp_path, agy.throwaway_key())
        card = "antigravity@fromfile"
        handle = f"{card}/{agy.SID8}~{agy.SID8}"
        stub.sessions = agy.Reply(201, '{"handle": "%s", "card": "%s", "created": true}' % (handle, card))
        stub.pending = agy.Reply(200, agy.announce_body(0, announce=False))
        (_config_dir(tmp_path) / "settings").write_text(f"A2A_SERVER_URL={stub.url}\nA2A_AGY_KEY_FILE={key_file}\nA2A_AGY_CARD={card}\n")
        result = _run_relative("./bin/a2a-agy-session", agy.hook_input(event="SessionStart"), _bare_env(tmp_path))
        assert (result.returncode, result.stderr) == (0, "")
        assert result.stdout == agy.session_line(handle, 0)
        (seen,) = stub.calls("/sessions")
        assert f'"card":"{card}"' in seen.body.decode()
    finally:
        stub.server.shutdown()
        stub.server.server_close()


def test_the_claude_scripts_take_url_key_file_and_card_from_the_file(tmp_path):
    register = hh.plugin_file("bin/a2a-register")
    hh.need_tools()
    stub = hh.StubServer()
    try:
        key_file, key = hh.make_key_file(tmp_path)
        card = "claude-code@fromfile"
        handle = f"{card}/agents-1~{hh.SID8}"
        stub.script("/sessions", hh.session_reply(handle))
        (_config_dir(tmp_path) / "settings").write_text(f"A2A_SERVER_URL={stub.url}\nA2A_KEY_FILE={key_file}\nA2A_CARD={card}\n")
        env = {**_bare_env(tmp_path), "A2A_STATE_DIR": str(tmp_path / "state"), "CLAUDE_CODE_SESSION_ATTENDED": "1"}
        result = hh.run_script(register, ["start"], stdin=hh.hook_json("SessionStart", source="startup"), env=env)
        assert (result.returncode, result.stderr) == (0, "")
        assert handle in result.stdout
        (seen,) = stub.requests("/sessions")
        assert seen.headers["authorization"] == f"Bearer {key}"
        assert f'"card": "{card}"' in seen.body or f'"card":"{card}"' in seen.body
    finally:
        stub.close()


def test_a_script_is_unchanged_when_the_lib_is_missing(tmp_path):
    """A copy of a script with no lib beside it still runs, silently, and exits 0: `.` of a missing
    file would end a POSIX shell with status 2, so the script tests with -r first."""
    for name in ("a2a-agy-pending", "a2a-agy-session", "a2a-pending", "a2a-register", "a2a-listen"):
        src = PLUGIN_DIR / "bin" / name
        if not src.is_file():
            pytest.skip(f"{src} is not present")
        lone = tmp_path / name
        lone.mkdir()
        shutil.copy(src, lone / name)
        env = {**_bare_env(tmp_path), "A2A_STATE_DIR": str(tmp_path / "state")}
        proc = subprocess.run(
            [shutil.which("dash") or "dash", str(lone / name), "start"], input="{}", capture_output=True, text=True, env=env, cwd=tmp_path, timeout=30, check=False
        )
        assert (proc.returncode, proc.stderr) == (0, ""), name


# ============================ review findings of PR #102 (Opus) ============================


def test_the_lib_trusts_only_a_settings_file_the_user_owns():
    """A file another local user owns (or can replace) could point A2A_SERVER_URL at their listener
    and collect the bearer key. The behaviour needs a file owned by someone else, which a test cannot
    create without root, so the guard is checked in the source and the positive case by the tests above."""
    source = LIB.read_text()
    assert '[ -O "$a2a_cfg_file" ]' in source


def test_a_settings_file_that_is_a_directory_is_ignored_silently(tmp_path):
    """The hand-run server stack keeps its cards in a directory named like the old default
    (`~/.config/a2a-coord/config/`); the settings file is `settings`, so the two cannot clash."""
    cfg = tmp_path / "settings"
    cfg.mkdir()
    (cfg / "cards.yaml").write_text("cards: []\n")
    out, err, rc, values = run_lib(tmp_path, None, env={"A2A_SETTINGS_FILE": str(cfg)})
    assert rc == 0 and err == "" and rc == 0
    assert all(v is None for v in values.values())


def test_the_default_settings_path_is_settings_not_config(tmp_path):
    home = tmp_path / "home"
    (home / ".config" / "a2a-coord").mkdir(parents=True)
    (home / ".config" / "a2a-coord" / "settings").write_text("A2A_CARD=from-settings\n")
    (home / ".config" / "a2a-coord" / "config").mkdir()
    out, err, rc, values = run_lib(tmp_path, None, env={"HOME": str(home), "A2A_SETTINGS_FILE": ""})
    assert (rc, err) == (0, "") and values["A2A_CARD"] == "from-settings"


BAD_URLS = ["--config=/tmp/x", "ftp://127.0.0.1:1", "http://127.0.0.1:1/ x", "http://x/$(id)", "http://x/;id", "file:///etc/passwd"]


@pytest.mark.parametrize("url", BAD_URLS)
@pytest.mark.parametrize("name", ["bin/a2a-register", "bin/a2a-pending", "bin/a2a-listen"])
def test_the_claude_scripts_refuse_a_server_url_that_could_become_a_curl_option(stub, hook_env, name, url):
    """The settings file can now set A2A_SERVER_URL: a value such as `--config=/tmp/x` would reach curl
    as `--config=/tmp/x/wake/pending`. The agy scripts already checked this; the Claude ones now do too."""
    script = hh.plugin_file(name)
    event = {"bin/a2a-register": "SessionStart", "bin/a2a-pending": "UserPromptSubmit", "bin/a2a-listen": "Stop"}[name]
    args = ["start"] if name == "bin/a2a-register" else []
    r = hh.run_script(script, args, stdin=hh.hook_json(event), env=hook_env(stub.url, A2A_SERVER_URL=url), timeout=30)
    assert (r.returncode, r.stdout, r.stderr) == (0, "", ""), (r.returncode, r.stdout, r.stderr)
    assert stub.requests("/sessions") == [] and stub.requests("/wake/pending") == [] and stub.requests("/wake/listen") == []


@pytest.mark.parametrize("name", ["bin/a2a-register", "bin/a2a-pending"])
def test_a_server_url_that_is_a_curl_option_is_not_followed_even_when_it_would_reach_the_stub(stub, hook_env, tmp_path, name):
    """The bad-URL cases above all miss the stub whether or not the guard exists, so they prove little for
    these two scripts. This one would have been followed: `-K<dir>/wake/pending` is the option `-K`
    (read a curl config file) with the file `<dir>/wake/pending`, and that file sends the request to the
    stub. Without the check the stub sees a request; with it, none."""
    cfg_dir = tmp_path / "optdir"
    (cfg_dir / "wake").mkdir(parents=True)
    (cfg_dir / "wake" / "pending").write_text(f'url = "{stub.url}/wake/pending"\n')  # for a2a-pending
    (cfg_dir / "sessions").write_text(f'url = "{stub.url}/sessions"\n')  # for a2a-register
    script = hh.plugin_file(name)
    event = "SessionStart" if name == "bin/a2a-register" else "UserPromptSubmit"
    args = ["start"] if name == "bin/a2a-register" else []
    url = f"-K{cfg_dir}"
    r = hh.run_script(script, args, stdin=hh.hook_json(event), env=hook_env(stub.url, A2A_SERVER_URL=url), timeout=30)
    assert (r.returncode, r.stdout, r.stderr) == (0, "", "")
    assert stub.requests("/sessions") == [] and stub.requests("/wake/pending") == []


@pytest.mark.parametrize("name", ["bin/a2a-register", "bin/a2a-pending", "bin/a2a-listen"])
def test_an_ipv6_literal_server_url_is_refused_by_the_claude_scripts(stub, hook_env, tmp_path, name):
    """The URL points at port 8120, not at the stub, so the stub could never see a request whether or not
    the guard exists (Opus review of PR #104). A fake `curl` first on PATH leaves a marker when it is
    called at all: refused means curl never runs."""
    marker = tmp_path / "curl-called"
    fake = hh.fake_tool(tmp_path / "fakebin", "curl", f"echo called > '{marker}'\nexit 0\n")
    event = {"bin/a2a-register": "SessionStart", "bin/a2a-pending": "UserPromptSubmit", "bin/a2a-listen": "Stop"}[name]
    args = ["start"] if name == "bin/a2a-register" else []
    env = hook_env(stub.url, A2A_SERVER_URL="http://[::1]:8120", PATH=hh.path_with(fake.parent))
    r = hh.run_script(hh.plugin_file(name), args, stdin=hh.hook_json(event), env=env, timeout=30)
    assert (r.returncode, r.stdout, r.stderr) == (0, "", "")
    assert not marker.exists(), "curl was called for a URL the guard should have refused"


def test_the_fake_curl_marker_does_fire_when_the_url_is_allowed(stub, hook_env, tmp_path):
    """The control for the test above: with an allowed URL the same fake curl is called, so the marker
    can only be absent because the guard refused."""
    marker = tmp_path / "curl-called"
    fake = hh.fake_tool(tmp_path / "fakebin", "curl", f"echo called > '{marker}'\nexit 0\n")
    env = hook_env(stub.url, PATH=hh.path_with(fake.parent))
    hh.run_script(hh.plugin_file("bin/a2a-pending"), [], stdin=hh.hook_json("UserPromptSubmit"), env=env, timeout=30)
    assert marker.exists()


def test_resolve_keyfile_logic(tmp_path):
    cfg = tmp_path / "home" / ".config" / "a2a-coord"
    keys = cfg / "keys"
    keys.mkdir(parents=True)
    
    # 1. Fallback when canonical missing
    fb = cfg / "api-key"
    fb.write_text("fb-key")
    driver = """
    . "$1"
    a2a_resolve_keyfile claude-code
    echo "resolved=$A2A_RESOLVED_KEYFILE"
    """
    out, _, _, _ = run_lib(tmp_path, None, driver=driver)
    assert "resolved=" in out and str(fb) in out

    # 2. Canonical wins over fallback when canonical present
    can = keys / "claude-code.key"
    can.write_text("can-key")
    out, _, _, _ = run_lib(tmp_path, None, driver=driver)
    assert str(can) in out

    # 3. Override wins over canonical
    ov = tmp_path / "override.key"
    ov.write_text("ov-key")
    driver_ov = """
    . "$1"
    A2A_KEY_FILE="%s"
    a2a_resolve_keyfile claude-code
    echo "resolved=$A2A_RESOLVED_KEYFILE"
    """ % ov
    out, _, _, _ = run_lib(tmp_path, None, driver=driver_ov)
    assert str(ov) in out


def test_resolve_keyfile_antigravity(tmp_path):
    cfg = tmp_path / "home" / ".config" / "a2a-coord"
    keys = cfg / "keys"
    keys.mkdir(parents=True)
    
    gemini_cfg = tmp_path / "home" / ".gemini" / "config"
    gemini_cfg.mkdir(parents=True)
    mcp = gemini_cfg / "mcp_config.json"
    mcp.write_text('{"mcpServers":{}}')

    can = keys / "antigravity.key"
    can.write_text("agy-can-key")

    driver = """
    . "$1"
    export HOME="%s"
    a2a_resolve_keyfile antigravity
    echo "resolved=$A2A_RESOLVED_KEYFILE"
    """ % (tmp_path / "home")
    
    out, _, _, _ = run_lib(tmp_path, None, driver=driver, env={"HOME": str(tmp_path / "home")})
    assert str(can) in out

    # Remove canonical, falls back to mcp_config.json
    can.unlink()
    out, _, _, _ = run_lib(tmp_path, None, driver=driver, env={"HOME": str(tmp_path / "home")})
    assert str(mcp) in out
