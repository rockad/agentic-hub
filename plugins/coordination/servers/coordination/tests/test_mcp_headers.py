"""Z22 WS2: `bin/a2a-mcp-headers`, Claude Code's MCP headersHelper (`docs/specs/harness-keys.md`
sections 2, 3, 4.1, 7) and `claude/mcp.json`.

Tests run `bin/a2a-mcp-headers` under `dash` and directly, checking:
- canonical `keys/claude-code.key` prints exact `{"Authorization":"Bearer <key>"}` and exits 0;
- one-release fallback to `api-key` when canonical is missing, and canonical wins when both exist;
- `A2A_KEY_FILE` override (env and settings file) is respected; `A2A_API_KEY` is ignored;
- missing, unreadable, directory, empty, or malformed key files fail closed (nothing on stdout/stderr, exit 1);
- `set +x` suppresses tracing, zero child processes (empty PATH), shellcheck/dash-n clean;
- `claude/mcp.json` declares `headersHelper` pointing to `${CLAUDE_PLUGIN_ROOT}/bin/a2a-mcp-headers`
  with no `headers` block, and `bin/a2a-mcp-headers` has mode 0755.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import stat
import subprocess
from pathlib import Path

import pytest
from conftest import PLUGIN_DIR
from hook_helpers import DASH

HELPER = PLUGIN_DIR / "bin" / "a2a-mcp-headers"
MCP_JSON = PLUGIN_DIR / "claude" / "mcp.json"


@pytest.fixture(autouse=True)
def _need_helper():
    if not HELPER.is_file():
        pytest.skip(f"{HELPER} is not present (the image build runs the suite with only src/ and tests/)")
    if shutil.which("dash") is None and not Path(DASH).exists():
        pytest.skip("dash is not installed")


def _throwaway_key() -> str:
    return f"a2ak_test_{secrets.token_hex(4)}_{secrets.token_urlsafe(24)}"


def _write_key(path: Path, content: str | bytes, mode: int = 0o600) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        path.write_bytes(content)
    else:
        path.write_text(content)
    path.chmod(mode)
    return path


def _run_helper(
    home: Path,
    *,
    env: dict[str, str] | None = None,
    dash_flags: list[str] | None = None,
    cwd: Path | None = None,
    direct: bool = True,
) -> subprocess.CompletedProcess[str]:
    full_env: dict[str, str] = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": str(home),
        "A2A_SETTINGS_FILE": "",
    }
    if env:
        full_env.update(env)
    if dash_flags or not direct:
        cmd = [DASH, *(dash_flags or []), str(HELPER)]
    else:
        cmd = [str(HELPER)]
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        env=full_env,
        cwd=cwd or PLUGIN_DIR,
        timeout=10,
        check=False,
    )


def test_valid_canonical_key_prints_exact_json_and_exits_0(tmp_path):
    key = _throwaway_key()
    _write_key(tmp_path / ".config" / "a2a-coord" / "keys" / "claude-code.key", key + "\n")

    proc = _run_helper(tmp_path)
    assert (proc.returncode, proc.stderr) == (0, "")
    assert proc.stdout == f'{{"Authorization":"Bearer {key}"}}\n'
    assert json.loads(proc.stdout) == {"Authorization": f"Bearer {key}"}


def test_valid_key_without_trailing_newline_is_accepted(tmp_path):
    key = _throwaway_key()
    _write_key(tmp_path / ".config" / "a2a-coord" / "keys" / "claude-code.key", key)

    proc = _run_helper(tmp_path)
    assert (proc.returncode, proc.stderr) == (0, "")
    assert proc.stdout == f'{{"Authorization":"Bearer {key}"}}\n'


def test_fallback_to_legacy_api_key_when_canonical_missing(tmp_path):
    key = _throwaway_key()
    _write_key(tmp_path / ".config" / "a2a-coord" / "api-key", key + "\n")

    proc = _run_helper(tmp_path)
    assert (proc.returncode, proc.stderr) == (0, "")
    assert proc.stdout == f'{{"Authorization":"Bearer {key}"}}\n'


def test_canonical_wins_when_both_canonical_and_legacy_exist(tmp_path):
    canonical_key = _throwaway_key()
    legacy_key = _throwaway_key()
    cfg = tmp_path / ".config" / "a2a-coord"
    _write_key(cfg / "keys" / "claude-code.key", canonical_key + "\n")
    _write_key(cfg / "api-key", legacy_key + "\n")

    proc = _run_helper(tmp_path)
    assert (proc.returncode, proc.stderr) == (0, "")
    assert proc.stdout == f'{{"Authorization":"Bearer {canonical_key}"}}\n'
    assert legacy_key not in proc.stdout


def test_a2a_key_file_env_override_is_respected(tmp_path):
    canonical_key = _throwaway_key()
    override_key = _throwaway_key()
    _write_key(tmp_path / ".config" / "a2a-coord" / "keys" / "claude-code.key", canonical_key + "\n")
    override_path = _write_key(tmp_path / "custom" / "override.key", override_key + "\n")

    proc = _run_helper(tmp_path, env={"A2A_KEY_FILE": str(override_path)})
    assert (proc.returncode, proc.stderr) == (0, "")
    assert proc.stdout == f'{{"Authorization":"Bearer {override_key}"}}\n'


def test_a2a_key_file_in_settings_file_is_respected(tmp_path):
    override_key = _throwaway_key()
    override_path = _write_key(tmp_path / "custom" / "from-settings.key", override_key + "\n")
    settings = tmp_path / ".config" / "a2a-coord" / "settings"
    settings.parent.mkdir(parents=True, exist_ok=True)
    settings.write_text(f"A2A_KEY_FILE={override_path}\n")

    proc = _run_helper(tmp_path, env={"A2A_SETTINGS_FILE": str(settings)})
    assert (proc.returncode, proc.stderr) == (0, "")
    assert proc.stdout == f'{{"Authorization":"Bearer {override_key}"}}\n'


def test_a2a_api_key_env_var_is_completely_ignored(tmp_path):
    env_key = _throwaway_key()
    # Missing key file + A2A_API_KEY set -> still fails closed!
    proc = _run_helper(tmp_path, env={"A2A_API_KEY": env_key})
    assert (proc.returncode, proc.stdout, proc.stderr) == (1, "", "")

    # Valid key file + different A2A_API_KEY -> uses key file, ignores A2A_API_KEY.
    file_key = _throwaway_key()
    _write_key(tmp_path / ".config" / "a2a-coord" / "keys" / "claude-code.key", file_key + "\n")
    proc2 = _run_helper(tmp_path, env={"A2A_API_KEY": env_key})
    assert (proc2.returncode, proc2.stderr) == (0, "")
    assert proc2.stdout == f'{{"Authorization":"Bearer {file_key}"}}\n'
    assert env_key not in proc2.stdout


def test_missing_key_file_fails_closed_silently(tmp_path):
    proc = _run_helper(tmp_path)
    assert (proc.returncode, proc.stdout, proc.stderr) == (1, "", "")


def test_directory_key_file_fails_closed_silently(tmp_path):
    key_dir = tmp_path / ".config" / "a2a-coord" / "keys" / "claude-code.key"
    key_dir.mkdir(parents=True)
    proc = _run_helper(tmp_path)
    assert (proc.returncode, proc.stdout, proc.stderr) == (1, "", "")


@pytest.mark.skipif(os.geteuid() == 0, reason="root can read mode-000 files")
def test_unreadable_key_file_fails_closed_silently(tmp_path):
    key = _throwaway_key()
    path = _write_key(tmp_path / "unreadable.key", key + "\n", mode=0o000)
    proc = _run_helper(tmp_path, env={"A2A_KEY_FILE": str(path)})
    assert (proc.returncode, proc.stdout, proc.stderr) == (1, "", "")


@pytest.mark.parametrize(
    "payload",
    [
        pytest.param(b"", id="empty"),
        pytest.param(b"\n", id="blank-newline"),
        pytest.param(b"   \n", id="whitespace-only"),
        pytest.param(b"a2ak_\n", id="prefix-only"),
        pytest.param(b"not_an_a2a_key_123\n", id="missing-prefix"),
        pytest.param(b"Bearer a2ak_test_1234_abcd\n", id="bearer-prefix"),
        pytest.param(b"a2ak_test_1234_abcd\r\n", id="crlf"),
        pytest.param(b" a2ak_test_1234_abcd\n", id="leading-space"),
        pytest.param(b"a2ak_test_1234_abcd \n", id="trailing-space"),
        pytest.param(b"a2ak_test_1234_abcd\textra\n", id="tab"),
        pytest.param(b'a2ak_test_1234_"bad"\n', id="double-quote"),
        pytest.param(b"a2ak_test_1234_'bad'\n", id="single-quote"),
        pytest.param(b"a2ak_test_1234_\\bad\n", id="backslash"),
        pytest.param(b"a2ak_test_1234_$(id)\n", id="dollar-parens"),
        pytest.param(b"a2ak_test_1234_\x07bell\n", id="control-char"),
        pytest.param(b"a2ak_test_1234_abcd\nsecond_line\n", id="two-lines"),
        pytest.param(b"a2ak_test_1234_abcd\n\n", id="trailing-blank-line"),
        pytest.param(b"a2ak_" + b"x" * 510 + b"\n", id="over-512-bytes"),
    ],
)
def test_empty_or_malformed_key_file_fails_closed_silently(tmp_path, payload):
    _write_key(tmp_path / ".config" / "a2a-coord" / "keys" / "claude-code.key", payload)
    proc = _run_helper(tmp_path)
    assert (proc.returncode, proc.stdout, proc.stderr) == (1, "", "")


def test_helper_runs_without_spawning_children_and_never_traces_key(tmp_path):
    key = _throwaway_key()
    _write_key(tmp_path / ".config" / "a2a-coord" / "keys" / "claude-code.key", key + "\n")

    # Empty PATH: only shell built-ins can run, proving no child process ever sees the key.
    empty_bin = tmp_path / "emptybin"
    empty_bin.mkdir()
    proc_empty = _run_helper(tmp_path, env={"PATH": str(empty_bin)}, direct=False)
    assert (proc_empty.returncode, proc_empty.stderr) == (0, "")
    assert proc_empty.stdout == f'{{"Authorization":"Bearer {key}"}}\n'

    # Even when invoked with `dash -x`, `set +x` runs before touching the key so no key leaks.
    proc_trace = _run_helper(tmp_path, dash_flags=["-x"])
    assert proc_trace.returncode == 0
    assert key not in proc_trace.stderr
    assert proc_trace.stdout == f'{{"Authorization":"Bearer {key}"}}\n'


def test_helper_invoked_by_relative_path_and_from_other_cwd(tmp_path):
    key = _throwaway_key()
    _write_key(tmp_path / ".config" / "a2a-coord" / "keys" / "claude-code.key", key + "\n")

    # From PLUGIN_DIR as `./bin/a2a-mcp-headers` (Claude Code's cwd is plugin root)
    proc_rel = subprocess.run(
        ["./bin/a2a-mcp-headers"],
        capture_output=True,
        text=True,
        env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(tmp_path), "A2A_SETTINGS_FILE": ""},
        cwd=PLUGIN_DIR,
        timeout=10,
        check=False,
    )
    assert (proc_rel.returncode, proc_rel.stderr) == (0, "")
    assert proc_rel.stdout == f'{{"Authorization":"Bearer {key}"}}\n'


def test_helper_is_executable_0755_posix_sh_dash_and_shellcheck_clean():
    mode = stat.S_IMODE(HELPER.stat().st_mode)
    assert mode == 0o755, f"expected 0755, got {oct(mode)}"

    text = HELPER.read_text()
    assert text.startswith("#!/bin/sh\n")
    code = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))
    assert "set +x" in code
    assert "unset A2A_API_KEY" in code
    assert "eval" not in code and "`" not in code
    for bashism in ("local ", "function ", "<<<", "&>", "${!", "declare ", "read -p", "echo -e", "==", "$RANDOM", "set -o pipefail"):
        assert bashism not in code, bashism
    assert not re.search(r"\[\[(?!:)", code)

    r_dash = subprocess.run([DASH, "-n", str(HELPER)], capture_output=True, text=True, check=False)
    assert r_dash.returncode == 0, r_dash.stderr

    if shutil.which("shellcheck") is not None:
        r_sc = subprocess.run(["shellcheck", "-s", "sh", "-S", "style", str(HELPER)], capture_output=True, text=True, check=False)
        assert r_sc.returncode == 0, r_sc.stdout + r_sc.stderr


def test_claude_mcp_json_uses_headers_helper_without_headers_block():
    data = json.loads(MCP_JSON.read_text())
    assert data == {
        "mcpServers": {
            "a2a-coord": {
                "type": "http",
                "url": "http://127.0.0.1:8120/mcp",
                "headersHelper": '"${CLAUDE_PLUGIN_ROOT}/bin/a2a-mcp-headers"',
            }
        }
    }
    assert "headers" not in data["mcpServers"]["a2a-coord"]
    assert "A2A_API_KEY" not in MCP_JSON.read_text()
