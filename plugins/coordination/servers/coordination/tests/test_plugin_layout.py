"""WS1 (decisions Z20 and Z21): `plugins/coordination` is ONE plugin directory that Claude Code and
Antigravity (agy) each install with their own command. These tests pin the layout:

- the two manifests parse and agree on name, version and description;
- Claude's files live in `claude/` and its manifest points at them (`hooks`: `./claude/hooks.json`,
  `mcpServers`: `./claude/mcp.json`), as Jev does, so agy, which reads only the root `hooks.json`, never
  sees a `hooks/hooks.json` or a `.mcp.json` it would warn about; the agy manifest has no such field;
- the agy `hooks.json` runs `./bin/<script>` (agy runs a plugin hook with the plugin folder as its
  working directory, A8c part 3) and the Claude `claude/hooks.json` runs
  `"${CLAUDE_PLUGIN_ROOT}/bin/<script>"`; every script they name exists and is executable;
- the agy-only scripts are in the agy hooks only, and `bin/a2a-doctor` (run by hand, WS2) is in neither hooks file;
- `claude/mcp.json` is the Claude MCP entry and the plugin ships no `mcp_config.json` (agy's entry lives in
  the user's global file and holds a key);
- the plugin is listed in both marketplace files with the same version.

No Docker, no agy, no claude. The files are outside `src/` and `tests/`, and the image build runs the
suite with only those two: every test skips when the plugin directory is not there, and the lookup of
the repository root must not raise at import.
"""

from __future__ import annotations

import json
import os
import re
import stat
from pathlib import Path

import pytest
from conftest import PLUGIN_DIR

try:
    REPO_ROOT: Path | None = PLUGIN_DIR.parents[1]
except IndexError:  # the server image runs the suite from a path without a repository above it
    REPO_ROOT = None

AGY_ONLY = {"a2a-agy-session", "a2a-agy-pending"}
CLAUDE_ONLY = {"a2a-register", "a2a-listen", "a2a-pending"}
# The doctor is run by hand, never as a hook: it is in neither hooks file (docs/specs/doctor.md).
DOCTOR = "a2a-doctor"
# The Claude Code MCP headersHelper is run by Claude Code via claude/mcp.json, never as a hook.
MCP_HELPER = "a2a-mcp-headers"
CLAUDE_ROOT_PREFIX = "${CLAUDE_PLUGIN_ROOT}/bin/"


@pytest.fixture(autouse=True)
def _need_plugin_dir():
    if not (PLUGIN_DIR / "plugin.json").is_file():
        pytest.skip(f"{PLUGIN_DIR} is not present (the image build runs the suite with only src/ and tests/)")


def load(path: Path) -> dict:
    return json.loads(path.read_text())


def need_repo_file(rel: str) -> Path:
    if REPO_ROOT is None or not (REPO_ROOT / rel).is_file():
        pytest.skip(f"{rel} is not reachable from {PLUGIN_DIR}")
    return REPO_ROOT / rel


def is_executable(path: Path) -> bool:
    return path.is_file() and bool(path.stat().st_mode & stat.S_IXUSR) and os.access(path, os.X_OK)


def agy_commands() -> list[tuple[str, str, int]]:
    data = load(PLUGIN_DIR / "hooks.json")
    return [(event, entry["command"], entry["timeout"]) for event, entries in data["a2a-coord"].items() for entry in entries]


def claude_commands() -> list[tuple[str, str]]:
    data = load(PLUGIN_DIR / "claude" / "hooks.json")["hooks"]
    return [(event, hook["command"]) for event, groups in data.items() for group in groups for hook in group["hooks"]]


# manifests ----------------------------------------------------------------------------------


def test_both_manifests_parse_and_agree_on_name_version_and_description():
    agy = load(PLUGIN_DIR / "plugin.json")
    claude = load(PLUGIN_DIR / ".claude-plugin" / "plugin.json")
    assert agy["name"] == claude["name"] == "coordination"
    assert agy["version"] == claude["version"]
    assert re.fullmatch(r"\d+\.\d+\.\d+", agy["version"])
    assert agy["description"] == claude["description"]


def test_claude_manifest_points_at_the_claude_folder_and_agy_manifest_at_nothing():
    """Claude's manifest names its two files (Jev does the same); the agy manifest has no such field.
    A `hooks` field naming `./hooks/hooks.json` would make Claude load the file twice (a known error), so
    the file is not in that folder at all."""
    claude = load(PLUGIN_DIR / ".claude-plugin" / "plugin.json")
    assert claude["hooks"] == "./claude/hooks.json" and claude["mcpServers"] == "./claude/mcp.json"
    for rel in (claude["hooks"], claude["mcpServers"]):
        assert (PLUGIN_DIR / rel).is_file(), rel
    agy = load(PLUGIN_DIR / "plugin.json")
    assert "hooks" not in agy and "mcpServers" not in agy


def test_the_plugin_root_holds_none_of_the_files_agy_warns_about():
    """agy's validator warns about a `.mcp.json` (never loaded) and a `hooks/hooks.json` (ignored) at the
    plugin root; both moved into claude/. (AGENTS.md is the one remaining warning: it is developer
    guidance for this folder, not a rule to ship.)"""
    assert not (PLUGIN_DIR / ".mcp.json").exists()
    assert not (PLUGIN_DIR / "hooks").exists()


def test_the_old_agy_fragment_directory_is_gone():
    assert not (PLUGIN_DIR / "agy").exists(), "the fragment moved to the root hooks.json"


# agy hooks ----------------------------------------------------------------------------------


def test_the_agy_hooks_file_runs_the_agy_scripts_from_the_plugin_folder():
    data = load(PLUGIN_DIR / "hooks.json")
    assert list(data) == ["a2a-coord"]
    assert sorted(data["a2a-coord"]) == ["PreInvocation", "SessionStart"]
    assert sorted(agy_commands()) == [
        ("PreInvocation", "./bin/a2a-agy-pending", 5),
        ("SessionStart", "./bin/a2a-agy-session", 10),
    ]
    for entry in (e for entries in data["a2a-coord"].values() for e in entries):
        assert set(entry) == {"type", "command", "timeout"} and entry["type"] == "command"


def test_every_agy_hook_command_is_a_relative_bin_path_to_an_executable_script():
    for _event, command, _timeout in agy_commands():
        assert re.fullmatch(r"\./bin/[a-z0-9-]+", command), command
        assert "~" not in command and "$" not in command and not command.startswith("/")
        assert is_executable(PLUGIN_DIR / command), f"{command} is missing or not executable"


# Claude hooks -------------------------------------------------------------------------------


def test_every_claude_hook_command_names_an_existing_executable_script_under_the_plugin_root():
    commands = claude_commands()
    assert commands, "claude/hooks.json holds no command"
    for _event, command in commands:
        match = re.fullmatch(r'"\$\{CLAUDE_PLUGIN_ROOT\}/bin/([a-z0-9-]+)"( (?:start|end))?', command)
        assert match, f"unexpected command shape: {command}"
        assert is_executable(PLUGIN_DIR / "bin" / match.group(1)), f"{command} is missing or not executable"


def test_the_claude_hooks_cover_the_claude_scripts_and_only_those():
    names = {re.search(r"/bin/([a-z0-9-]+)", c).group(1) for _e, c in claude_commands()}  # type: ignore[union-attr]
    assert names == CLAUDE_ONLY


# the two harnesses do not share the other's scripts ----------------------------------------


def test_the_agy_only_scripts_are_listed_in_the_agy_hooks_only():
    agy_names = {Path(c).name for _e, c, _t in agy_commands()}
    claude_text = (PLUGIN_DIR / "claude" / "hooks.json").read_text()
    assert agy_names == AGY_ONLY
    for name in AGY_ONLY:
        assert name not in claude_text, f"{name} is agy-only and must not be a Claude hook"
    for name in CLAUDE_ONLY:
        assert name not in json.dumps(load(PLUGIN_DIR / "hooks.json")), f"{name} is Claude-only"


def test_the_bin_directory_holds_exactly_the_known_scripts_the_doctor_and_the_settings_lib():
    bin_dir = PLUGIN_DIR / "bin"
    assert {p.name for p in bin_dir.iterdir()} == AGY_ONLY | CLAUDE_ONLY | {DOCTOR, MCP_HELPER, "a2a-lib.sh"}
    assert not is_executable(bin_dir / "a2a-lib.sh"), "the lib is sourced, never run"
    assert is_executable(bin_dir / DOCTOR), "the doctor is run by hand: it must be executable"
    assert is_executable(bin_dir / MCP_HELPER), "the MCP headers helper is run by Claude Code: it must be executable"


def test_neither_hooks_file_names_the_doctor_or_mcp_helper():
    """`a2a-doctor` is a command the user runs by hand (it may print and exit non-zero, which a hook
    must not): a hook that ran it would be a bug. `a2a-mcp-headers` is run by Claude Code's MCP client."""
    for path in (PLUGIN_DIR / "hooks.json", PLUGIN_DIR / "claude" / "hooks.json"):
        text = path.read_text()
        assert DOCTOR not in text, f"{path.name} names the doctor"
        assert MCP_HELPER not in text, f"{path.name} names the MCP helper"
    assert DOCTOR not in {Path(c).name for _e, c, _t in agy_commands()}
    assert DOCTOR not in {re.search(r"/bin/([a-z0-9-]+)", c).group(1) for _e, c in claude_commands()}  # type: ignore[union-attr]


def test_every_script_that_reads_a_setting_sources_the_lib_before_it_reads_one():
    names = ("A2A_SERVER_URL", "A2A_KEY_FILE", "A2A_CARD", "A2A_AGY_KEY_FILE", "A2A_AGY_CARD")
    for name in sorted(AGY_ONLY | CLAUDE_ONLY | {DOCTOR, MCP_HELPER}):
        code = [line for line in (PLUGIN_DIR / "bin" / name).read_text().splitlines() if not line.lstrip().startswith("#")]
        source = next((i for i, line in enumerate(code) if "a2a_load_config" in line), None)
        assert source is not None, f"{name} never loads the settings file"
        first_read = next((i for i, line in enumerate(code) if any(f"${{{n}:-" in line for n in names)), None)
        assert first_read is None or source < first_read, f"{name} reads a setting before the lib is sourced"


# MCP entries --------------------------------------------------------------------------------


def test_the_claude_mcp_entry_is_one_http_server_with_headers_helper():
    data = load(PLUGIN_DIR / "claude" / "mcp.json")
    assert list(data) == ["mcpServers"]
    assert data["mcpServers"] == {
        "a2a-coord": {
            "type": "http",
            "url": "http://127.0.0.1:8120/mcp",
            "headersHelper": "${CLAUDE_PLUGIN_ROOT}/bin/a2a-mcp-headers",
        }
    }
    raw = (PLUGIN_DIR / "claude" / "mcp.json").read_text()
    assert "headers" not in data["mcpServers"]["a2a-coord"]
    assert "A2A_API_KEY" not in raw
    assert "a2ak_" not in raw, "a key never goes into the plugin"
    assert is_executable(PLUGIN_DIR / "bin" / MCP_HELPER)


def test_the_plugin_ships_no_agy_mcp_config():
    """agy's entry is a user-scope server in the user's global mcp_config.json (Z20 item 4, option C):
    a file of this name in the plugin would be a second server and a place for a key."""
    skip = {".venv", "node_modules", "__pycache__", ".git", ".pytest_cache", ".ruff_cache"}
    found = []
    for root, dirs, files in os.walk(PLUGIN_DIR):
        dirs[:] = [d for d in dirs if d not in skip]
        found += [Path(root, f) for f in files if f == "mcp_config.json"]
    assert found == []


# marketplaces -------------------------------------------------------------------------------


def test_the_plugin_is_listed_in_the_claude_marketplace_with_the_same_version():
    market = load(need_repo_file(".claude-plugin/marketplace.json"))
    entries = [p for p in market["plugins"] if p["name"] == "coordination"]
    assert len(entries) == 1
    assert entries[0]["source"] == "./plugins/coordination"
    assert entries[0]["version"] == load(PLUGIN_DIR / "plugin.json")["version"]
    assert entries[0]["description"]


def test_the_plugin_is_listed_in_the_root_marketplace_with_the_same_version():
    market = load(need_repo_file("marketplace.json"))
    entries = [p for p in market["plugins"] if p["id"] == "coordination"]
    assert len(entries) == 1
    assert entries[0]["path"] == "plugins/coordination"
    assert entries[0]["version"] == load(PLUGIN_DIR / "plugin.json")["version"]
    assert entries[0]["name"] and entries[0]["description"]
