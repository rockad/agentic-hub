"""Invariant (api 9, D9, DDR-003): the server launches, drives, wraps or messages no harness process.
No `agy -p`, no PTY, no tmux, no `agentapi`, no `claude -p` anywhere in the server or its scripts.

A scoped static search:

- every module under `src/coordination/` except `cli/install/` (the installer, when it exists, has its
  own narrower rule below);
- the hook scripts in `bin/` and the backup sidecar's scripts.

`pty` is allowed only under `tests/` (the S1-ADMIN refusal tests), so it is not on any allowlist here.
The one legitimate `subprocess` user is `db_admin.py` (it feeds SQL to `psql` in the Postgres container);
its entry says why. A stale allowlist entry fails the test, so the list cannot rot into a blanket pass.

The scanners are in `sec_scan.py`. The meta-tests at the bottom feed them a snippet with each forbidden
token and check it is caught: a scanner that finds nothing proves nothing until it has found something.
"""

from __future__ import annotations

from pathlib import Path

import pytest

pytestmark = pytest.mark.hooks
import sec_scan
from conftest import PLUGIN_DIR

import coordination

SRC = Path(coordination.__file__).resolve().parent  # the imported package: what runs, wherever it was installed from
BIN = PLUGIN_DIR / "bin"
BACKUP = PLUGIN_DIR / "servers" / "backup"

#: (source label, token) -> why that one use is legitimate. Nothing else is allowed.
ALLOWLIST: dict[tuple[str, str], str] = {
    # `a2a-coord db init-dump-role` (a host command, not a server path) pipes SQL into `psql` inside the
    # Postgres container with `docker compose exec -T`. It touches no harness; its argv names docker,
    # compose, psql and nothing else.
    ("coordination/db_admin.py", "subprocess"): "Postgres role setup via docker compose exec",
}

#: The installer, once it exists (S1-INST): `subprocess` is allowed there for the `chezmoi` and
#: `claude --version` invocations only. Everything else in the forbidden list still applies.
INSTALL_DIR = "cli/install"
INSTALL_TOKENS_ALLOWED = frozenset({"subprocess"})


def _findings(sources: list[sec_scan.Source]) -> list[tuple[str, str, int, str]]:
    out = []
    for source in sources:
        for token, line, text in sec_scan.scan(source):
            if (source.label, token) in ALLOWLIST:
                continue
            out.append((source.label, token, line, text))
    return out


def test_the_server_modules_start_no_process_and_name_no_harness_driver():
    sources = sec_scan.python_sources(SRC, exclude=(INSTALL_DIR,))
    assert len(sources) > 60, "the scan found almost no modules: the path is wrong, not the code clean"
    assert _findings(sources) == []


def test_every_allowlist_entry_is_still_needed():
    used = {(s.label, token) for s in sec_scan.python_sources(SRC, exclude=(INSTALL_DIR,)) for token, _, _ in sec_scan.scan(s)}
    stale = sorted(set(ALLOWLIST) - used)
    assert stale == [], f"allowlist entries that match nothing: {stale}"


def test_the_allowed_subprocess_never_names_a_harness():
    """`db_admin.py` is allowed `subprocess`; check what it runs is docker and psql, nothing else."""
    import re

    text = (SRC / "db_admin.py").read_text()
    argv_words = set(re.findall(r'"(docker|compose|exec|psql|claude|agy|tmux)"', text))
    assert argv_words <= {"docker", "compose", "exec", "psql"}, argv_words


def test_the_installer_when_it_exists_may_run_chezmoi_and_claude_version_only():
    directory = SRC / INSTALL_DIR
    if not directory.is_dir():
        # Not a skip: there is nothing to scan until S1-INST lands, and the rule is in force from then on.
        return
    bad = []
    for source in sec_scan.python_sources(SRC):
        if not source.label.startswith("coordination/" + INSTALL_DIR):
            continue
        for token, line, text in sec_scan.scan(source):
            if token not in INSTALL_TOKENS_ALLOWED:
                bad.append((source.label, token, line, text))
    assert bad == []


def _shell_sources() -> list[sec_scan.Source]:
    return sec_scan.shell_sources(BIN, "bin") + sec_scan.shell_sources(BACKUP, "servers/backup")


def test_the_scripts_launch_no_harness_and_name_no_driver():
    if not BIN.is_dir():
        # The server image's build runs the suite with only src/ and tests/. The CI checkout step runs this.
        pytest.skip("bin/ is outside the image build context; the CI checkout run covers it")
    sources = _shell_sources()
    labels = {s.label for s in sources}
    assert {"bin/a2a-listen", "bin/a2a-register", "bin/a2a-pending", "bin/a2a-agy-session", "bin/a2a-agy-pending", "bin/a2a-lib.sh"} <= labels
    assert _findings(sources) == []


# -- meta-tests: the scanners catch what they are meant to catch ------------------------------------------


@pytest.mark.parametrize(
    ("token", "snippet"),
    [
        ("subprocess", "import subprocess\n"),
        ("subprocess", "from subprocess import run\n"),
        ("subprocess", "import subprocess as sp\n"),
        ("pty", "import pty\n"),
        ("pty", "from pty import spawn\n"),
        ("pexpect", "import pexpect\n"),
        ("os.system", "import os\nos.system('x')\n"),
        ("os.popen", "import os\nos.popen('x')\n"),
        ("os.execvp", "import os\nos.execvp('a', ['a'])\n"),
        ("os.spawnl", "import os\nos.spawnl(0, 'a')\n"),
        ("os.forkpty", "import os\nos.forkpty()\n"),
        ("os.system", "from os import system\n"),
        ("create_subprocess_exec", "import asyncio\nasync def f():\n    await asyncio.create_subprocess_exec('x')\n"),
        ("Popen", "import foo\nfoo.Popen(['x'])\n"),
        ("tmux", "cmd = ['tmux', 'send-keys']\n"),
        ("tmux", "cmd = 'tmux send-keys -t x'\n"),
        ("agentapi", "cmd = 'agentapi attach'\n"),
        ("claude -p", "cmd = 'claude -p hello'\n"),
        ("claude", "cmd = ['claude', '-p', 'hello']\n"),
        ("agy -p", "cmd = 'agy -p hello'\n"),
        ("agy", "cmd = ['agy', '--prompt', 'hello']\n"),
        ("agy", "cmd = ['agy', 'run']\n"),
        ("claude", "cmd = ['claude', '--version']\n"),
        ("pty", "name = 'pty'\n"),
        ("subprocess", "m = __import__('subprocess')\n"),
    ],
)
def test_the_python_scanner_catches_each_forbidden_token(token, snippet):
    assert token in {t for t, _, _ in sec_scan.scan_python(snippet)}, (token, snippet)


@pytest.mark.parametrize(
    "snippet",
    [
        '"""Docstring about agy, tmux, a PTY and claude -p."""\n',
        "def f():\n    '''Runs `claude -p` never.'''\n",
        "# a comment about subprocess and agentapi\nx = 1\n",
        "label = 'Claude Code'\nother = 'auto_agy'\nprefix = 'AGY_'\n",
        "text = 'the agy conversation id'\n",
        "import os\nos.environ.get('A')\nos.path.join('a')\n",
    ],
)
def test_the_python_scanner_ignores_prose_comments_and_docstrings(snippet):
    assert sec_scan.scan_python(snippet) == []


@pytest.mark.parametrize(
    ("token", "snippet"),
    [
        ("agy", "agy --version\n"),
        ("agy", "exec agy run\n"),
        ("agy", "x=$(agy status)\n"),
        ("agy", "nohup agy &\n"),
        ("agy", "if true; then agy go; fi\n"),
        ("agy", "/usr/local/bin/agy go\n"),
        ("claude", "claude --resume\n"),
        ("claude", "timeout 5 claude hello\n"),
        ("claude", "echo x | claude\n"),
        ("claude -p", "echo \"claude -p hi\"\n"),
        ("agy -p", "printf 'agy -p hi'\n"),
        ("tmux", "tmux send-keys -t s x\n"),
        ("tmux", "echo tmux\n"),
        ("agentapi", "agentapi server\n"),
        ("pty", "script -c x /dev/null # pty\nx=\"pty\"\n"),
        ("subprocess", "echo subprocess\n"),
        ("claude", 'x="\\" #"; claude -p hi\n'),
        ("claude -p", 'x="\\" #"; claude -p hi\n'),
        ("claude", "FOO=1 claude --resume\n"),
        ("claude", "FOO='1 2' BAR=x claude --resume\n"),
        ("claude", "env FOO=1 claude --resume\n"),
        ("agy", "cat <<EOF\n$(agy -p hi)\nEOF\n"),
        ("agy -p", "cat <<EOF\n$(agy -p hi)\nEOF\n"),
        ("agy", "cat <<EOF\n$(agy status)\nEOF\n"),
        ("claude", "cat <<EOF\n`claude --resume`\nEOF\n"),
    ],
)
def test_the_shell_scanner_catches_each_forbidden_token(token, snippet):
    assert token in {t for t, _, _ in sec_scan.scan_shell(snippet)}, (token, snippet)


@pytest.mark.parametrize(
    "snippet",
    [
        "# agy and claude are mentioned here, tmux too\n",
        "x=1  # then run claude -p later\n",
        "section \"Antigravity (agy)\"\n",
        'info "Claude Code: claude plugin install x"\n',
        'echo "agy file is missing"\n',
        "agy_file=\"$HOME/x\"\n",
        "cat <<'EOF'\nagy says hello\nclaude go\nEOF\n",
        "cat <<'EOF'\n$(agy status)\nEOF\n",
        'cat <<"EOF"\n$(agy status)\nEOF\n',
        "cat <<\\EOF\n$(agy status)\nEOF\n",
        "cat <<-'EOF'\n$(agy status)\nEOF\n",
        "cat <<EOF\nclaude says hello\nfoo | claude\nEOF\n",
        'printf "%s" "$#"\n',
        "'claude-code|claude-code@|keys/claude-code.key|A2A_KEY_FILE|cfg:api-key' \\\n",
        "claude-code)\n",
        'dr_cmcp="$DIR/../claude/mcp.json"\n',
        'A2A_RESOLVED_KEYFILE="$a2a_rk_cfgdir/keys/claude-code.key"\n',
    ],
)
def test_the_shell_scanner_ignores_comments_prose_and_heredoc_text(snippet):
    assert sec_scan.scan_shell(snippet) == []


def test_a_heredoc_does_not_hide_the_words_that_are_never_ours():
    assert {t for t, _, _ in sec_scan.scan_shell("cat <<EOF\ntmux new\nEOF\n")} == {"tmux"}


def test_a_tree_with_a_launch_in_a_module_and_a_script_fails_the_same_scan(tmp_path):
    """The whole path of the real test, on a scratch tree: a module that imports `subprocess` and a
    script that runs `claude -p` are both reported, and an allowlisted label would not be."""
    src = tmp_path / "src"
    (src / "cli" / "install").mkdir(parents=True)
    (src / "ok.py").write_text('"""Mentions agy and tmux in prose only."""\nx = 1\n')
    (src / "bad.py").write_text("import subprocess\nsubprocess.run(['x'])\n")
    (src / "cli" / "install" / "inst.py").write_text("import subprocess\n")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "hook").write_text("#!/bin/sh\nclaude -p 'do it'\n")
    sources = sec_scan.python_sources(src, exclude=(INSTALL_DIR,)) + sec_scan.shell_sources(bin_dir, "bin")
    found = {(label, token) for label, token, _, _ in _findings(sources)}
    assert ("coordination/bad.py", "subprocess") in found
    assert ("bin/hook", "claude") in found and ("bin/hook", "claude -p") in found
    assert not any(label.startswith("coordination/cli/install") for label, _ in found)  # excluded, scanned separately
    assert not any(label == "coordination/ok.py" for label, _ in found)
