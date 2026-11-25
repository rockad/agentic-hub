"""WS2 (decision Z21 item 7): `bin/a2a-doctor`, the command the user runs by hand to check the install.

It prints one line per check (`OK`, `WARN`, `FAIL`, `INFO`) in sections, ends with `a2a-doctor: N FAIL, M
WARN` and exits 0 (no FAIL), 1 (a FAIL) or 2 (usage). What these tests pin, each against the real script
under dash (and under `bash --posix`), a stub HTTP server and a throwaway HOME:

- every check, green and red: the plugin files, the settings file and its directory, the Claude key file,
  `A2A_API_KEY`, the agy file (entry, url, header, key, orphans, with and without `jq`), the server
  (`/healthz` 200, 500, refused, slow; the probe session 201, 401, 403, 410, a bad handle, a handle of
  another card; the probe is ended again), the URL guard, `--no-network`, the exit statuses;
- every run, through the `World.run` wrapper: the output is well formed and ASCII, the summary counts match
  the lines, no key (nor a piece of one) is printed, nothing under the temporary tree is created, changed or
  touched (HOME, TMPDIR and the working directory are compared before and after), and neither `agy` nor
  `claude` is ever started (fakes first on PATH leave a marker);
- the keys never reach a child's argument list or environment (the existing sampler, and a fake curl that
  records what it is given), and reach curl on stdin;
- the script itself: `#!/bin/sh`, executable, `dash -n`, `shellcheck -s sh -S style`, no bashism, every curl
  call bounded and with the key on stdin, nothing in it that writes.

No Docker, no agy, no claude. The script is outside `src/` and `tests/`, which the image build runs alone:
every test skips when it is absent, and nothing here raises at import.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import shutil
import stat
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

import agy_hook_helpers as agy
import pytest
from conftest import PLUGIN_DIR, free_port
from hook_helpers import (
    DASH,
    Reply,
    StubServer,
    fake_tool,
    plugin_file,
    session_reply,
    stub,  # noqa: F401  (fixture)
)

CLAUDE_CARD = "claude-code@box"
AGY_CARD = "antigravity@box"
CLAUDE_HANDLE = "claude-code@box/doctor-1~3f2a9c1d"
AGY_HANDLE = "antigravity@box/doctor-2~3f2a9c1e"
BASH = shutil.which("bash")
HAVE_JQ = shutil.which("jq") is not None
IS_ROOT = hasattr(os, "geteuid") and os.geteuid() == 0
LINE = re.compile(r"^(OK|WARN|FAIL|INFO) {1,4}(\S.*)$")
SUMMARY = re.compile(r"^a2a-doctor: (\d+) FAIL, (\d+) WARN$")
# The tools the doctor runs, for a PATH that has no jq in it.
TOOLS = ("curl", "stat", "tr", "sed", "grep", "head", "tail", "cut", "uname", "sort", "sha256sum")

need_jq = pytest.mark.skipif(not HAVE_JQ, reason="jq is not installed")
need_non_root = pytest.mark.skipif(IS_ROOT, reason="root can read and own everything")


@pytest.fixture(autouse=True)
def _need_doctor():
    plugin_file("bin/a2a-doctor")
    if shutil.which("curl") is None:
        pytest.skip("curl is not installed")


def doctor_path() -> Path:
    return plugin_file("bin/a2a-doctor")


def throwaway_key() -> str:
    return agy.throwaway_key()


def key_parts(key: str) -> list[str]:
    """The key and its inner pieces: none of them may ever appear in an output or a child's argv."""
    return [key, *[p for p in key.split("_")[2:] if len(p) >= 8]]


def agy_config(url: str, key: str | None, *, servers_before: dict | None = None, servers_after: dict | None = None, auth: bool = True) -> dict:
    entry: dict = {"type": "http", "url": f"{url}/mcp"}
    if auth:
        entry["headers"] = {"Authorization": f"Bearer {key}"}
    servers: dict = dict(servers_before or {})
    servers["a2a-coord"] = entry
    servers.update(servers_after or {})
    return {"mcpServers": servers}


def snapshot(root: Path) -> dict[str, tuple]:
    """Mode, mtime, size and content hash of everything under `root` (and the root itself)."""
    out: dict[str, tuple] = {}
    for path in [root, *sorted(root.rglob("*"))]:
        st = path.lstat()
        digest = ""
        if path.is_file() and not path.is_symlink():
            try:
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
            except OSError:
                digest = "unreadable"
        out[str(path)] = (stat.S_IMODE(st.st_mode), st.st_mtime_ns, st.st_size, digest)
    return out


def nojq_path(directory: Path) -> str:
    """A PATH holding only the tools the doctor runs, no jq."""
    directory.mkdir(parents=True, exist_ok=True)
    for tool in TOOLS:
        real = shutil.which(tool)
        assert real, tool
        link = directory / tool
        if not link.exists():
            link.symlink_to(real)
    return str(directory)


@dataclass
class Result:
    proc: subprocess.CompletedProcess[str]

    @property
    def out(self) -> str:
        return self.proc.stdout

    @property
    def code(self) -> int:
        return self.proc.returncode

    @property
    def lines(self) -> list[tuple[str, str]]:
        found = []
        for line in self.out.splitlines():
            m = LINE.match(line)
            if m:
                found.append((m.group(1), m.group(2)))
        return found

    def of(self, level: str) -> list[str]:
        return [msg for lvl, msg in self.lines if lvl == level]

    def has(self, level: str, *subs: str) -> bool:
        return any(all(s in msg for s in subs) for msg in self.of(level))

    def count(self, level: str) -> int:
        return len(self.of(level))

    def expect(self, level: str, *subs: str) -> None:
        assert self.has(level, *subs), f"no {level} line with {subs!r} in:\n{self.out}"

    def expect_none(self, level: str, *subs: str) -> None:
        assert not self.has(level, *subs), f"unexpected {level} line with {subs!r} in:\n{self.out}"


class World:
    """A throwaway HOME laid out like a real one: the config directory (mode 0700), keys/ (0700)
    with canonical claude-code.key and antigravity.key (0600), and the global agy file (0600) with
    a matching `a2a-coord` entry that points at `url`."""

    def __init__(self, tmp: Path) -> None:
        self.tmp = tmp
        self.home = tmp / "home"
        self.cfg = self.home / ".config" / "a2a-coord"
        self.keys_dir = self.cfg / "keys"
        self.key_file = self.keys_dir / "claude-code.key"
        self.agy_key_file = self.keys_dir / "antigravity.key"
        self.legacy_claude_file = self.cfg / "api-key"
        self.agy_dir = self.home / ".gemini" / "config"
        self.agy_file = self.agy_dir / "mcp_config.json"
        self.tmpdir = tmp / "tmpdir"
        self.cwd = tmp / "cwd"
        self.fakebin = tmp / "fakebin"
        self.markers = tmp / "markers"
        self.claude_key = throwaway_key()
        self.agy_key = throwaway_key()
        self.secrets = [*key_parts(self.claude_key), *key_parts(self.agy_key)]
        for d in (self.cfg, self.keys_dir, self.agy_dir, self.tmpdir, self.cwd, self.markers):
            d.mkdir(parents=True, exist_ok=True)
        self.cfg.chmod(0o700)
        self.keys_dir.chmod(0o700)
        self.key_file.write_text(self.claude_key + "\n")
        self.key_file.chmod(0o600)
        self.agy_key_file.write_text(self.agy_key + "\n")
        self.agy_key_file.chmod(0o600)
        self.write_agy("http://127.0.0.1:8120")
        # a fake `agy` and `claude`: if the doctor ever started one, it leaves a marker
        for name in ("agy", "claude"):
            fake_tool(self.fakebin, name, f'echo "$0 $*" >> "{self.markers}/{name}"\nexit 0\n')

    def write_agy(self, url: str, key: str | None = None, **kw) -> None:
        self.agy_file.write_text(json.dumps(agy_config(url, key or self.agy_key, **kw)))
        self.agy_file.chmod(0o600)

    def env(self, url: str, **extra: str | None) -> dict[str, str]:
        env = {
            "PATH": f"{self.fakebin}:{os.environ.get('PATH', '/usr/bin:/bin')}",
            "HOME": str(self.home),
            "LANG": "C",
            "TMPDIR": str(self.tmpdir),
            "A2A_SERVER_URL": url,
            "A2A_CARD": CLAUDE_CARD,
            "A2A_AGY_CARD": AGY_CARD,
        }
        for name, value in extra.items():
            if value is None:
                env.pop(name, None)
            else:
                env[name] = value
        return env

    def run(
        self,
        *args: str,
        url: str = "http://127.0.0.1:1",
        runner: list[str] | None = None,
        snap: bool = True,
        extra_secrets: tuple[str, ...] = (),
        timeout: float = 60,
        **extra: str | None,
    ) -> Result:
        env = self.env(url, **extra)
        before = snapshot(self.tmp) if snap else None
        proc = subprocess.run(
            [*(runner or [DASH]), str(doctor_path()), *args],
            capture_output=True,
            text=True,
            env=env,
            cwd=self.cwd,
            timeout=timeout,
            check=False,
        )
        res = Result(proc)
        self.check_invariants(res, extra_secrets, args)
        if before is not None:
            assert snapshot(self.tmp) == before, "the doctor changed something under the temporary tree"
        return res

    def check_invariants(self, res: Result, extra_secrets: tuple[str, ...], args: tuple[str, ...]) -> None:
        if res.code == 2:  # a usage error: nothing but the usage line, on stderr
            return
        out = res.out
        assert res.code in (0, 1), (res.code, res.proc.stderr)
        for line in out.splitlines():
            ok = not line or line.startswith("== ") or LINE.match(line) or SUMMARY.match(line)
            assert ok, f"a line of no known shape: {line!r}"
        assert out.isascii() and res.proc.stderr.isascii()
        assert "\x1b" not in out, "no colour"
        summary = [m for m in (SUMMARY.match(line) for line in out.splitlines()) if m]
        assert len(summary) == 1, out
        assert (int(summary[0].group(1)), int(summary[0].group(2))) == (res.count("FAIL"), res.count("WARN")), out
        assert res.code == (1 if res.count("FAIL") else 0), (res.code, out)
        for secret in (*self.secrets, *extra_secrets):
            assert secret not in out, "a key (or a piece of one) was printed"
            assert secret not in res.proc.stderr, "a key (or a piece of one) reached stderr"
        for name in ("agy", "claude"):
            assert not (self.markers / name).exists(), f"the doctor started {name}"


@pytest.fixture
def world(tmp_path):
    return World(tmp_path)


def ready(stub: StubServer, *, claude: Reply | None = None, agy_reply: Reply | None = None, end: Reply | None = None) -> StubServer:
    """The stub answers /healthz 200, the two registrations (Claude first, then agy) and /sessions/end."""
    stub.script("/healthz", Reply(200, '{"ok":true}'))
    stub.script("/sessions", claude or session_reply(CLAUDE_HANDLE), agy_reply or session_reply(AGY_HANDLE))
    stub.script("/sessions/end", end or Reply(200, '{"ended":true}'))
    return stub


def green(world: World, stub: StubServer, **kw) -> Result:
    world.write_agy(stub.url)
    ready(stub)
    return world.run(url=stub.url, **kw)


# ---- the happy path and the exit statuses -----------------------------------------------------


@need_jq
def test_a_healthy_install_is_all_green_and_exits_0(world, stub):
    res = green(world, stub)
    assert res.code == 0, res.out
    assert (res.count("FAIL"), res.count("WARN")) == (0, 0), res.out
    assert res.out.rstrip().endswith("a2a-doctor: 0 FAIL, 0 WARN")
    res.expect("OK", "GET", "/healthz answered 200")
    res.expect("OK", "claude-code key accepted: registered as", CLAUDE_HANDLE)
    res.expect("OK", "antigravity key accepted: registered as", AGY_HANDLE)
    res.expect("OK", "antigravity key file and mcp_config.json literal match")
    res.expect("OK", "claude/mcp.json declares headersHelper pointing to bin/a2a-mcp-headers")
    res.expect("OK", "bin/a2a-mcp-headers present and executable")
    res.expect("INFO", "claude-code probe session ended")
    res.expect("INFO", "antigravity probe session ended")


@need_jq
def test_the_doctor_calls_healthz_without_a_key_and_registers_and_ends_a_probe_per_harness(world, stub):
    green(world, stub)
    (health,) = stub.requests("/healthz")
    assert health.method == "GET" and "authorization" not in health.headers
    regs = stub.requests("/sessions")
    ends = stub.requests("/sessions/end")
    assert [r.method for r in regs] == ["POST", "POST"] and [e.method for e in ends] == ["POST", "POST"]
    for reg, end, card, key in zip(regs, ends, (CLAUDE_CARD, AGY_CARD), (world.claude_key, world.agy_key), strict=True):
        body = json.loads(reg.body)
        assert body["card"] == card and re.fullmatch(r"doctor-[0-9]+", body["harness_session_id"]), body
        assert reg.headers["authorization"] == f"Bearer {key}"
        assert json.loads(end.body) == body
        assert end.headers["authorization"] == f"Bearer {key}"
        assert reg.at < end.at
    assert regs[0].at < ends[0].at < regs[1].at < ends[1].at  # Claude's probe, ended, then agy's


def test_the_output_has_the_documented_sections_in_order(world, stub):
    res = green(world, stub)
    heads = [line for line in res.out.splitlines() if line.startswith("== ")]
    assert heads == [
        "== Install commands ==",
        "== Plugin files ==",
        "== Settings file ==",
        "== Harness: claude-code ==",
        "== Harness: antigravity ==",
        "== Server ==",
    ]


def test_the_install_commands_and_the_remote_main_rule_are_always_printed(world):
    res = world.run("--no-network")
    res.expect("INFO", "claude plugin marketplace add rockad/agentic-hub")
    res.expect("INFO", "claude plugin install coordination@agentic-hub")
    res.expect("INFO", "agy plugin install https://github.com/rockad/agentic-hub/tree/main/plugins/coordination")
    res.expect("INFO", "remote main", "never copy or symlink")


@pytest.mark.parametrize("args", [("--bogus",), ("--no-network", "--no-network"), ("a", "b"), ("",), ("-n",), ("--no-network", "x")])
def test_a_usage_error_exits_2_with_the_usage_on_stderr_and_nothing_on_stdout(world, args):
    res = world.run(*args)
    assert res.code == 2
    assert res.out == ""
    assert "usage: a2a-doctor [--no-network]" in res.proc.stderr


def test_help_prints_the_usage_and_exits_0(world):
    for flag in ("-h", "--help"):
        proc = subprocess.run([DASH, str(doctor_path()), flag], capture_output=True, text=True, env=world.env("http://127.0.0.1:1"), check=False)
        assert proc.returncode == 0 and "usage: a2a-doctor" in proc.stdout and proc.stderr == ""


def test_exit_status_is_1_exactly_when_there_is_a_fail(world):
    ok = world.run("--no-network")
    assert ok.code == 0 and ok.count("FAIL") == 0
    world.key_file.unlink()
    bad = world.run("--no-network")
    assert bad.code == 1 and bad.count("FAIL") == 1


def test_a_warning_alone_does_not_make_the_exit_status_1(world):
    world.key_file.chmod(0o644)
    res = world.run("--no-network")
    res.expect("WARN", "wider than 600")
    assert res.count("FAIL") == 0 and res.code == 0


# ---- --no-network and the URL guard -----------------------------------------------------------


def test_no_network_makes_no_request(world, stub):
    ready(stub)
    res = world.run("--no-network", url=stub.url)
    assert stub.seen == []
    res.expect("INFO", "--no-network")
    res.expect_none("FAIL", "healthz")


def test_no_network_also_runs_when_nothing_listens(world):
    res = world.run("--no-network", url=f"http://127.0.0.1:{free_port()}")
    assert res.count("FAIL") == 0 and res.code == 0, res.out
    res.expect_none("FAIL", "no answer")


@pytest.mark.parametrize(
    "bad",
    [
        "ftp://127.0.0.1/x",
        "127.0.0.1:8120",
        "http://127.0.0.1:8120/a b",
        "http://127.0.0.1:8120/x;touch-y",
        "http://127.0.0.1:8120/$(x)",
        "http://127.0.0.1:8120/`x`",
        "-o/tmp/x",
        "http://",
        "http://h/é",
    ],
)
def test_a_bad_server_url_is_a_fail_with_the_reason_and_skips_the_network(world, stub, bad):
    ready(stub)
    res = world.run(url=bad)
    assert res.code == 1
    assert res.has("FAIL", "A2A_SERVER_URL") and res.has("FAIL", "network checks are skipped"), res.out
    assert bad == "http://" or not any(bad.strip() in m for m in res.of("FAIL")), "the bad value is not echoed"
    assert stub.seen == []
    assert "REPLACE_WITH_YOUR_KEY" in res.out  # the snippet still prints, with the default url
    res.expect("INFO", "http://127.0.0.1:8120/mcp")


def test_a_server_url_with_a_trailing_slash_is_accepted(world, stub):
    ready(stub)
    res = world.run(url=stub.url + "/")
    res.expect("OK", "/healthz answered 200")
    assert [s.path for s in stub.requests("/healthz")] == ["/healthz"]


def test_the_server_url_can_come_from_the_settings_file(world, stub):
    ready(stub)
    settings = world.cfg / "settings"
    settings.write_text(f"A2A_SERVER_URL={stub.url}\n")
    settings.chmod(0o600)
    res = world.run(url=stub.url, A2A_SERVER_URL=None)
    res.expect("OK", "/healthz answered 200")
    assert stub.requests("/healthz")


def test_the_key_and_card_settings_are_read_through_the_lib(world, stub):
    """A key file named only in the settings file is the one checked and used."""
    ready(stub)
    other = world.tmp / "other-key"
    other.write_text(world.claude_key + "\n")
    other.chmod(0o640)
    world.key_file.unlink()
    settings = world.cfg / "settings"
    settings.write_text(f"A2A_KEY_FILE={other}\nA2A_CARD={CLAUDE_CARD}\n")
    settings.chmod(0o600)
    res = world.run(url=stub.url, A2A_KEY_FILE=None, A2A_CARD=None)
    res.expect("WARN", str(other), "wider than 600")
    res.expect_none("FAIL", "missing")
    assert json.loads(stub.requests("/sessions")[0].body)["card"] == CLAUDE_CARD


# ---- plugin files -----------------------------------------------------------------------------


def copy_plugin(tmp: Path) -> Path:
    """A copy of bin/, claude/ and plugin.json, to break the install in ways the real tree must not be."""
    plug = tmp / "plug"
    shutil.copytree(PLUGIN_DIR / "bin", plug / "bin")
    shutil.copytree(PLUGIN_DIR / "claude", plug / "claude")
    shutil.copy2(PLUGIN_DIR / "plugin.json", plug / "plugin.json")
    return plug / "bin" / "a2a-doctor"


def run_copy(world: World, script: Path, *args: str, path: str | None = None, runner: list[str] | None = None) -> Result:
    env = world.env("http://127.0.0.1:1")
    if path is not None:
        env["PATH"] = f"{world.fakebin}:{path}"
    proc = subprocess.run([*(runner or [DASH]), str(script), *args], capture_output=True, text=True, env=env, cwd=world.cwd, check=False, timeout=60)
    res = Result(proc)
    world.check_invariants(res, (), args)
    return res


def test_all_scripts_are_found_and_the_version_is_printed(world):
    res = world.run("--no-network")
    for name in ("a2a-register", "a2a-listen", "a2a-pending", "a2a-agy-session", "a2a-agy-pending"):
        res.expect("OK", name, "present and executable")
    res.expect("OK", "a2a-lib.sh found next to a2a-doctor")
    expected = json.loads((PLUGIN_DIR / "plugin.json").read_text())["version"]
    res.expect("INFO", f"plugin version {expected}")


def test_a_missing_script_is_a_fail(world):
    script = copy_plugin(world.tmp)
    (script.parent / "a2a-pending").unlink()
    res = run_copy(world, script, "--no-network")
    res.expect("FAIL", "a2a-pending is missing")
    assert res.code == 1


def test_a_script_that_is_not_executable_is_a_fail(world):
    script = copy_plugin(world.tmp)
    (script.parent / "a2a-listen").chmod(0o644)
    res = run_copy(world, script, "--no-network")
    res.expect("FAIL", "a2a-listen is not executable")
    res.expect("OK", "a2a-register present and executable")


def test_a_missing_lib_is_a_fail_and_the_rest_still_runs(world):
    script = copy_plugin(world.tmp)
    (script.parent / "a2a-lib.sh").unlink()
    res = run_copy(world, script, "--no-network")
    res.expect("FAIL", "a2a-lib.sh not found next to a2a-doctor")
    assert res.code == 1
    assert res.has("OK", "a2a-register present"), res.out
    assert [h for h in res.out.splitlines() if h.startswith("== ")][-1] == "== Server =="


def test_the_version_is_read_with_and_without_jq(world):
    expected = json.loads((PLUGIN_DIR / "plugin.json").read_text())["version"]
    script = copy_plugin(world.tmp)
    res = run_copy(world, script, "--no-network", path=nojq_path(world.tmp / "nojq"))
    assert shutil.which("jq", path=str(world.tmp / "nojq")) is None
    res.expect("INFO", f"plugin version {expected}")


def test_an_unreadable_plugin_json_is_a_warning(world):
    script = copy_plugin(world.tmp)
    (script.parents[1] / "plugin.json").write_text("{not json")
    res = run_copy(world, script, "--no-network")
    res.expect("WARN", "plugin version not readable")
    (script.parents[1] / "plugin.json").unlink()
    res = run_copy(world, script, "--no-network")
    res.expect("WARN", "plugin version not readable")


def test_the_doctor_finds_the_lib_whatever_way_it_is_started(world):
    """`./a2a-doctor` from its own directory, `sh a2a-doctor` with no slash, and through a symlink-free
    absolute path all find the lib next to the script."""
    bin_dir = PLUGIN_DIR / "bin"
    for argv in ([DASH, "a2a-doctor"], [DASH, "./a2a-doctor"], ["./a2a-doctor"]):
        proc = subprocess.run([*argv, "--no-network"], capture_output=True, text=True, env=world.env("http://127.0.0.1:1"), cwd=bin_dir, check=False, timeout=60)
        res = Result(proc)
        res.expect("OK", "a2a-lib.sh found next to a2a-doctor")


# ---- the settings file and the config directory -----------------------------------------------


def test_a_missing_settings_file_is_info_because_settings_are_optional(world):
    res = world.run("--no-network")
    res.expect("INFO", "no settings file at", str(world.cfg / "settings"), "optional")
    assert res.count("FAIL") == 0 or not res.has("FAIL", "settings")


def test_a_directory_at_the_settings_path_is_a_fail(world):
    (world.cfg / "settings").mkdir()
    res = world.run("--no-network")
    res.expect("FAIL", "is a directory; the hooks ignore it")
    assert res.code == 1


@pytest.mark.parametrize(("mode", "wide"), [(0o600, False), (0o400, False), (0o644, True), (0o640, True), (0o666, True), (0o700, True), (0o604, True)])
def test_the_settings_file_mode_is_checked_against_0600(world, mode, wide):
    settings = world.cfg / "settings"
    settings.write_text("A2A_CARD=claude-code@box\n")
    settings.chmod(mode)
    res = world.run("--no-network")
    if wide:
        res.expect("WARN", "settings file mode", f"{mode:o}", "wider than 600")
    else:
        res.expect_none("WARN", "settings file")
        res.expect("OK", f"settings file mode {mode:o}")


@need_non_root
def test_a_settings_file_the_user_does_not_own_is_a_warning(world):
    foreign = Path("/etc/passwd")
    if not foreign.exists() or foreign.stat().st_uid == os.geteuid():
        pytest.skip("no root-owned file to point at")
    res = world.run("--no-network", A2A_SETTINGS_FILE=str(foreign))
    res.expect("WARN", "not owned by you", "the hooks ignore a file you do not own")


@need_non_root
def test_an_unreadable_settings_file_is_a_warning(world):
    settings = world.cfg / "settings"
    settings.write_text("A2A_CARD=claude-code@box\n")
    settings.chmod(0o000)
    try:
        res = world.run("--no-network")
    finally:
        settings.chmod(0o600)
    res.expect("WARN", "not readable")


@pytest.mark.parametrize(("mode", "wide"), [(0o700, False), (0o500, False), (0o755, True), (0o750, True), (0o710, True), (0o777, True)])
def test_the_config_directory_mode_is_checked_against_0700(world, mode, wide):
    world.cfg.chmod(mode)
    try:
        res = world.run("--no-network")
    finally:
        world.cfg.chmod(0o700)
    if wide:
        res.expect("WARN", "config directory", f"{mode:o}", "wider than 700")
    else:
        res.expect("OK", "config directory", f"{mode:o}")


def test_a_missing_config_directory_is_info(world):
    shutil.rmtree(world.cfg)
    res = world.run("--no-network")
    res.expect("INFO", "no config directory at")


def test_the_settings_path_follows_a2a_settings_file_and_xdg_config_home(world):
    other = world.tmp / "elsewhere"
    other.write_text("")
    other.chmod(0o644)
    res = world.run("--no-network", A2A_SETTINGS_FILE=str(other))
    res.expect("WARN", str(other), "wider than 600")
    xdg = world.tmp / "xdg"
    (xdg / "a2a-coord").mkdir(parents=True)
    (xdg / "a2a-coord").chmod(0o755)
    (xdg / "a2a-coord" / "settings").write_text("")
    (xdg / "a2a-coord" / "settings").chmod(0o666)
    res = world.run("--no-network", XDG_CONFIG_HOME=str(xdg))
    res.expect("WARN", str(xdg / "a2a-coord" / "settings"), "wider than 600")
    res.expect("WARN", "config directory", str(xdg / "a2a-coord"), "wider than 700")


def test_the_mode_falls_back_to_the_bsd_stat_form(world):
    """macOS `stat` has no -c: a fake `stat` that fails on -c and answers `-f %Lp` stands in for it."""
    body = (
        'case "$1" in\n'
        '  -c) exit 1 ;;\n'
        '  -f) f=$3; [ "$2" = "%Lp" ] || exit 1\n'
        '      case $f in *claude-code.key) echo 644 ;; *a2a-mcp-headers) echo 755 ;; *) echo 700 ;; esac ;;\n'
        'esac\n'
    )
    fake_tool(world.tmp / "bsd", "stat", body)
    res = world.run("--no-network", PATH=f"{world.tmp / 'bsd'}:{world.fakebin}:{os.environ['PATH']}")
    res.expect("WARN", "claude-code key file", "mode 644", "wider than 600")


def test_an_unreadable_mode_is_info_not_a_failure(world):
    fake_tool(world.tmp / "nostat", "stat", "exit 1\n")
    res = world.run("--no-network", PATH=f"{world.tmp / 'nostat'}:{world.fakebin}:{os.environ['PATH']}")
    res.expect("INFO", "claude-code key file", "mode could not be read")
    res.expect("INFO", "antigravity key file", "mode could not be read")
    res.expect("INFO", "keys directory", "mode could not be read")
    res.expect("INFO", "agy file mode could not be read")
    res.expect("INFO", "config directory", "mode could not be read")
    assert res.count("FAIL") == 0


# ---- the Claude key, headersHelper, and keys/ dir ---------------------------------------------


def test_a_missing_claude_key_file_is_a_fail_that_says_how_to_create_it_and_creates_nothing(world):
    world.key_file.unlink()
    res = world.run("--no-network")
    res.expect("FAIL", str(world.key_file), "missing", "mode-0600", "first line is the API key")
    assert not world.key_file.exists()
    assert res.code == 1


def test_a_directory_at_the_key_path_is_a_fail(world):
    world.key_file.unlink()
    world.key_file.mkdir()
    res = world.run("--no-network")
    res.expect("FAIL", "is a directory")


@need_non_root
def test_an_unreadable_claude_key_file_is_a_fail(world):
    world.key_file.chmod(0o000)
    try:
        res = world.run("--no-network")
    finally:
        world.key_file.chmod(0o600)
    res.expect("FAIL", "claude-code key file", "not readable")


@pytest.mark.parametrize(("mode", "wide"), [(0o600, False), (0o400, False), (0o640, True), (0o644, True), (0o660, True), (0o604, True), (0o700, True)])
def test_the_claude_key_file_mode_is_checked_against_0600(world, mode, wide):
    world.key_file.chmod(mode)
    try:
        res = world.run("--no-network")
    finally:
        world.key_file.chmod(0o600)
    if wide:
        res.expect("WARN", "claude-code key file", f"mode {mode:o}", "wider than 600")
    else:
        res.expect("OK", "claude-code key file", f"mode {mode:o}")
        res.expect_none("WARN", "claude-code key file")


@pytest.mark.parametrize(("mode", "wide"), [(0o700, False), (0o500, False), (0o755, True), (0o750, True), (0o777, True)])
def test_the_keys_directory_mode_is_checked_against_0700(world, mode, wide):
    world.keys_dir.chmod(mode)
    try:
        res = world.run("--no-network")
    finally:
        world.keys_dir.chmod(0o700)
    if wide:
        res.expect("WARN", "keys directory", f"mode {mode:o}", "wider than 700")
    else:
        res.expect("OK", "keys directory", f"mode {mode:o}")
        res.expect_none("WARN", "keys directory")


def test_a_good_claude_key_is_ok_and_never_shown(world):
    res = world.run("--no-network")
    res.expect("OK", "claude-code key file first line looks like an a2a key")


@pytest.mark.parametrize(
    "content",
    [
        "hello\n",
        "",
        "\n",
        "a2ak_\n",
        "a2ak_has space\n",
        "a2ak_tab\there\n",
        "a2ak_test_deadbeef_SECRETSECRETSECRET\r\n",
        "\na2ak_test_deadbeef_SECRETSECRETSECRET\n",
        "Bearer a2ak_test_deadbeef_SECRETSECRETSECRET\n",
        "a2ak_test_deadbeef_SECRET'SECRET\n",
        'a2ak_test_deadbeef_SECRET"SECRET\n',
        "a2ak_test_deadbeef_SECRET$SECRET\n",
        "A2AK_test_deadbeef_SECRETSECRET\n",
    ],
)
def test_a_key_file_that_does_not_look_like_a_key_is_a_fail_and_is_never_printed(world, stub, content):
    ready(stub, claude=session_reply(AGY_HANDLE))
    world.write_agy(stub.url)
    world.key_file.write_text(content)
    world.key_file.chmod(0o600)
    res = world.run(url=stub.url, extra_secrets=("SECRETSECRET",))
    res.expect("FAIL", "does not look like an a2a key")
    assert res.code == 1
    res.expect("INFO", "claude-code probe skipped")
    # the antigravity probe is independent of the claude-code key: at most that one registration is made
    assert len(stub.requests("/sessions")) <= 1


def test_the_probe_runs_for_a_key_with_every_allowed_character(world, stub):
    key = "a2ak_test_abc123_A-b.c_d~e+f/g=h"
    world.key_file.write_text(key + "\n")
    world.key_file.chmod(0o600)
    world.write_agy(stub.url)
    ready(stub)
    res = world.run(url=stub.url, extra_secrets=("A-b.c_d~e+f/g=h",))
    res.expect("OK", "claude-code key accepted")
    assert stub.requests("/sessions")[0].headers["authorization"] == f"Bearer {key}"


def test_only_the_first_line_of_the_key_file_counts(world, stub):
    world.key_file.write_text(world.claude_key + "\nsecond line with spaces\n")
    world.key_file.chmod(0o600)
    world.write_agy(stub.url)
    ready(stub)
    res = world.run(url=stub.url)
    res.expect("OK", "claude-code key accepted")


def test_a2a_api_key_is_not_checked_or_warned_and_never_printed(world):
    value = "a2ak_test_envenv_ENVSECRETVALUE" + secrets.token_hex(4)
    for env_val in (value, None, "", "something-else"):
        res = world.run("--no-network", url="http://127.0.0.1:8120", A2A_API_KEY=env_val, extra_secrets=(value, "ENVSECRETVALUE"))
        assert "A2A_API_KEY" not in res.out
        assert (res.count("FAIL"), res.count("WARN")) == (0, 0), res.out


def test_claude_fallback_api_key_warns_with_migration_commands_and_still_probes(world, stub):
    world.key_file.unlink()
    world.legacy_claude_file.write_text(world.claude_key + "\n")
    world.legacy_claude_file.chmod(0o600)
    world.write_agy(stub.url)
    ready(stub)
    res = world.run(url=stub.url)
    assert res.code == 0
    res.expect("WARN", "claude-code canonical key file", "is missing; using one-release fallback")
    res.expect("INFO", "mkdir -p -m 700 ~/.config/a2a-coord/keys")
    res.expect("INFO", "mv ~/.config/a2a-coord/api-key ~/.config/a2a-coord/keys/claude-code.key")
    res.expect("INFO", "bin/a2a-doctor")
    res.expect("OK", "claude-code key accepted")
    assert stub.requests("/sessions")[0].headers["authorization"] == f"Bearer {world.claude_key}"


def test_claude_canonical_wins_over_legacy_api_key_without_warning(world, stub):
    legacy = throwaway_key()
    world.legacy_claude_file.write_text(legacy + "\n")
    world.legacy_claude_file.chmod(0o600)
    world.write_agy(stub.url)
    ready(stub)
    res = world.run(url=stub.url, extra_secrets=tuple(key_parts(legacy)))
    assert (res.count("FAIL"), res.count("WARN")) == (0, 0), res.out
    res.expect_none("WARN", "one-release fallback")
    assert stub.requests("/sessions")[0].headers["authorization"] == f"Bearer {world.claude_key}"


def test_claude_headers_helper_and_mcp_json_checks(world):
    script = copy_plugin(world.tmp)
    res = run_copy(world, script, "--no-network")
    res.expect("OK", "claude/mcp.json declares headersHelper pointing to bin/a2a-mcp-headers")
    res.expect("OK", "bin/a2a-mcp-headers present and executable")

    # Executable but not 0755 -> WARN
    helper = script.parent / "a2a-mcp-headers"
    helper.chmod(0o750)
    res_mode = run_copy(world, script, "--no-network")
    res_mode.expect("WARN", "bin/a2a-mcp-headers is executable but mode 750 is not 0755")
    assert res_mode.code == 0

    # Non-executable helper -> FAIL
    helper.chmod(0o644)
    res_nx = run_copy(world, script, "--no-network")
    res_nx.expect("FAIL", "bin/a2a-mcp-headers is not executable")
    assert res_nx.code == 1

    # Missing helper -> FAIL
    helper.unlink()
    res_miss = run_copy(world, script, "--no-network")
    res_miss.expect("FAIL", "bin/a2a-mcp-headers is missing")
    assert res_miss.code == 1

    # Missing headersHelper in claude/mcp.json -> FAIL
    mcp_json = script.parents[1] / "claude" / "mcp.json"
    mcp_json.write_text(json.dumps({"mcpServers": {"a2a-coord": {"type": "http", "url": "http://127.0.0.1:8120/mcp"}}}))
    res_nohh = run_copy(world, script, "--no-network")
    res_nohh.expect("FAIL", "claude/mcp.json does not declare headersHelper")
    assert res_nohh.code == 1


def test_a_key_file_named_by_the_environment_is_the_one_checked(world):
    other = world.tmp / "elsewhere-key"
    other.write_text(world.claude_key + "\n")
    other.chmod(0o666)
    world.key_file.unlink()
    res = world.run("--no-network", A2A_KEY_FILE=str(other))
    res.expect("WARN", str(other), "wider than 600")
    res.expect_none("FAIL", "missing")


# ---- agy ---------------------------------------------------------------------------------------


def test_a_missing_agy_file_is_a_warning_with_the_snippet_and_not_a_fail(world):
    world.agy_file.unlink()
    res = world.run("--no-network")
    res.expect("WARN", "agy entry not set up", str(world.agy_file), "does not exist")
    assert res.count("FAIL") == 0 and res.code == 0


def test_the_agy_snippet_is_printed_with_the_placeholder_and_the_effective_url(world):
    res = world.run("--no-network", url="http://127.0.0.1:9999")
    snippet = next(m for m in res.of("INFO") if m.startswith('{"mcpServers"'))
    assert json.loads(snippet) == {
        "mcpServers": {
            "a2a-coord": {
                "type": "http",
                "url": "http://127.0.0.1:9999/mcp",
                "headers": {"Authorization": "Bearer a2ak_REPLACE_WITH_YOUR_KEY"},
            }
        }
    }
    res.expect("INFO", "merge it into the existing mcpServers object", "by hand", "mode 0600", "the plugin never edits it")
    assert "a2ak_" not in snippet.replace("a2ak_REPLACE_WITH_YOUR_KEY", "")


def test_the_snippet_url_is_the_default_when_none_is_set(world):
    res = world.run("--no-network", A2A_SERVER_URL=None)
    assert any("http://127.0.0.1:8120/mcp" in m for m in res.of("INFO"))


@pytest.mark.parametrize(("mode", "wide"), [(0o600, False), (0o400, False), (0o644, True), (0o660, True), (0o666, True)])
def test_the_agy_file_mode_is_checked_against_0600(world, mode, wide):
    world.agy_file.chmod(mode)
    try:
        res = world.run("--no-network")
    finally:
        world.agy_file.chmod(0o600)
    if wide:
        res.expect("WARN", "agy file", f"mode {mode:o}", "wider than 600", "holds a key")
    else:
        res.expect("OK", "agy file", f"mode {mode:o}")


@need_jq
def test_a_good_agy_entry_is_ok(world):
    world.write_agy("http://127.0.0.1:8120")
    res = world.run("--no-network", url="http://127.0.0.1:8120")
    res.expect("OK", "agy file has an a2a-coord server entry")
    res.expect("OK", "agy file holds an a2ak_ key")
    res.expect("OK", "agy entry url is http://127.0.0.1:8120/mcp")
    res.expect("OK", "agy entry has an Authorization header")
    assert not [m for m in res.of("WARN") if "agy" in m or "orphan" in m], res.out


def test_a_file_without_an_a2a_coord_entry_is_a_warning(world):
    world.agy_file.write_text(json.dumps({"mcpServers": {"obsidian": {"serverUrl": "http://127.0.0.1:1/mcp"}}}))
    world.agy_file.chmod(0o600)
    res = world.run("--no-network")
    res.expect("WARN", "agy entry not set up", "no a2a-coord server entry")
    assert res.count("FAIL") == 0


def test_an_empty_object_and_a_file_without_mcpservers_are_a_missing_entry(world):
    for content in ("{}", '{"mcpServers": null}', '{"mcpServers": []}', '{"other": {"a2a-coord": 1}}'):
        world.agy_file.write_text(content)
        res = world.run("--no-network")
        res.expect("WARN", "agy entry not set up")
        assert res.count("FAIL") == 0, content


@pytest.mark.parametrize(
    "mutate",
    [
        pytest.param(lambda c: c["mcpServers"]["a2a-coord"].pop("headers"), id="no-headers"),
        pytest.param(lambda c: c["mcpServers"]["a2a-coord"].update(headers={"Authorization": "Bearer nothing"}), id="header-without-a-key"),
        pytest.param(lambda c: c["mcpServers"]["a2a-coord"].update(headers={"Authorization": "Bearer a2ak_short"}), id="malformed-key"),
        pytest.param(lambda c: c["mcpServers"]["a2a-coord"].update(headers={"Authorization": "Bearer a2ak_REPLACE_WITH_YOUR_KEY"}), id="placeholder"),
    ],
)
def test_an_entry_without_a_usable_key_is_a_fail(world, mutate):
    config = agy_config("http://127.0.0.1:8120", world.agy_key)
    mutate(config)
    world.agy_file.write_text(json.dumps(config))
    res = world.run("--no-network")
    assert res.has("FAIL", "agy file"), res.out
    assert res.code == 1


def test_an_entry_without_a_key_is_a_fail_with_the_no_key_wording(world):
    world.agy_file.write_text(json.dumps(agy_config("http://127.0.0.1:8120", None, auth=False)))
    res = world.run("--no-network")
    res.expect("FAIL", "has an a2a-coord entry but no a2ak_ key")
    assert res.code == 1


def test_the_placeholder_key_is_a_fail_and_is_not_probed(world, stub):
    ready(stub)
    world.agy_key_file.unlink()
    config = agy_config(stub.url, "a2ak_REPLACE_WITH_YOUR_KEY")
    world.agy_file.write_text(json.dumps(config))
    res = world.run(url=stub.url)
    res.expect("FAIL", "still holds the placeholder key")
    res.expect("INFO", "antigravity probe skipped")
    assert len(stub.requests("/sessions")) == 1  # Claude's only


@need_jq
def test_an_entry_url_that_is_not_the_effective_server_url_is_a_warning_and_is_not_echoed(world):
    leaky = f"http://elsewhere.example/mcp?k={world.agy_key}"
    config = agy_config("http://127.0.0.1:8120", world.agy_key)
    config["mcpServers"]["a2a-coord"]["url"] = leaky
    world.agy_file.write_text(json.dumps(config))
    res = world.run("--no-network", url="http://127.0.0.1:8120")
    res.expect("WARN", "agy entry url is not http://127.0.0.1:8120/mcp")
    assert "elsewhere" not in res.out


@need_jq
def test_the_legacy_serverurl_key_counts_as_the_entry_url(world):
    config = agy_config("http://127.0.0.1:8120", world.agy_key)
    entry = config["mcpServers"]["a2a-coord"]
    entry["serverUrl"] = entry.pop("url")
    world.agy_file.write_text(json.dumps(config))
    res = world.run("--no-network", url="http://127.0.0.1:8120")
    res.expect("OK", "agy entry url is http://127.0.0.1:8120/mcp")


@need_jq
def test_a_first_key_that_is_not_the_entrys_key_is_a_warning(world):
    other = throwaway_key()
    config = agy_config(
        "http://127.0.0.1:8120",
        world.agy_key,
        servers_before={"obsidian": {"url": "http://127.0.0.1:1", "headers": {"Authorization": f"Bearer {other}"}}},
    )
    world.agy_file.write_text(json.dumps(config))
    res = world.run("--no-network", extra_secrets=tuple(key_parts(other)))
    res.expect("WARN", "first a2ak_ key", "not the one in the a2a-coord entry")


@need_jq
def test_a_file_that_is_not_valid_json_is_a_warning_and_the_text_checks_still_run(world):
    world.agy_file.write_text('{"mcpServers": {"a2a-coord": {"headers": {"Authorization": "Bearer ' + world.agy_key + '"}}},}')
    res = world.run("--no-network")
    res.expect("WARN", "not a valid JSON object")
    res.expect("OK", "agy file has an a2a-coord server entry")
    res.expect("OK", "holds an a2ak_ key")


def test_a_directory_at_the_agy_path_is_a_fail(world):
    world.agy_file.unlink()
    world.agy_file.mkdir()
    res = world.run("--no-network")
    res.expect("FAIL", "agy file", "is a directory")


@need_non_root
def test_an_unreadable_agy_file_is_a_warning(world):
    world.agy_file.chmod(0o000)
    try:
        res = world.run("--no-network")
    finally:
        world.agy_file.chmod(0o600)
    res.expect("WARN", "agy file", "not readable")
    assert res.count("FAIL") == 0


def test_the_agy_key_file_named_by_the_environment_is_the_one_checked(world):
    other = world.tmp / "elsewhere-agy.key"
    other.write_text(world.agy_key + "\n")
    other.chmod(0o666)
    world.agy_key_file.unlink()
    res = world.run("--no-network", A2A_AGY_KEY_FILE=str(other))
    res.expect("WARN", str(other), "wider than 600")
    res.expect("OK", "antigravity key file first line looks like an a2a key")
    res.expect("OK", "antigravity key file and mcp_config.json literal match")
    res.expect_none("FAIL", "missing")


def test_agy_fallback_mcp_config_warns_with_migration_commands_and_still_probes(world, stub):
    world.agy_key_file.unlink()
    world.write_agy(stub.url)
    ready(stub)
    res = world.run(url=stub.url)
    assert res.code == 0
    res.expect("WARN", "antigravity canonical key file", "is missing; using one-release fallback")
    res.expect("INFO", "mkdir -p -m 700 ~/.config/a2a-coord/keys")
    res.expect("INFO", "jq -r '.mcpServers[\"a2a-coord\"].headers.Authorization' ~/.gemini/config/mcp_config.json")
    res.expect("INFO", "bin/a2a-doctor")
    res.expect("OK", "antigravity key accepted")
    assert stub.requests("/sessions")[1].headers["authorization"] == f"Bearer {world.agy_key}"


@need_jq
def test_agy_hash_compare_matches_and_warns_when_differing_without_printing_keys(world, tmp_path_factory):
    # Matching (even without trailing newline in keys/antigravity.key) -> OK, 0 WARN
    world.agy_key_file.write_text(world.agy_key)
    res_ok = world.run("--no-network")
    res_ok.expect("OK", "antigravity key file and mcp_config.json literal match")
    res_ok.expect_none("WARN", "differ")

    # Differing -> WARN, neither key printed anywhere
    other = throwaway_key()
    world.write_agy("http://127.0.0.1:8120", key=other)
    res_diff = world.run("--no-network", extra_secrets=tuple(key_parts(other)))
    res_diff.expect("WARN", "antigravity key file and mcp_config.json literal differ")
    assert res_diff.code == 0

    # Verify hash tool receives key on stdin only, never argv/env
    log = tmp_path_factory.mktemp("hashlog") / "hash.log"
    real_sha = shutil.which("sha256sum")
    if real_sha:
        spy_body = f'{{ printf "ARGV:%s\\n" "$*"; env | sed "s/^/ENV:/"; }} >> "$A2A_HASH_LOG"\nexec {real_sha} "$@"\n'
        fake_tool(world.tmp / "hashspy", "sha256sum", spy_body)
        res_spy = world.run(
            "--no-network",
            snap=False,
            PATH=f"{world.tmp / 'hashspy'}:{world.fakebin}:{os.environ['PATH']}",
            A2A_HASH_LOG=str(log),
            extra_secrets=tuple(key_parts(other)),
        )
        res_spy.expect("WARN", "antigravity key file and mcp_config.json literal differ")
        spy_text = log.read_text()
        assert world.agy_key not in spy_text and other not in spy_text


def test_the_old_pre_z20_plugin_folder_file_is_an_orphan_warning_with_its_exact_path(world):
    old = world.home / ".gemini" / "config" / "plugins" / "coordination" / "mcp_config.json"
    old.parent.mkdir(parents=True)
    old.write_text(json.dumps({"mcpServers": {"a2a": {"url": "http://127.0.0.1:8120/mcp"}}}))
    old.chmod(0o600)
    res = world.run("--no-network")
    res.expect("WARN", "orphan", str(old), "delete it by hand")
    assert old.exists(), "the doctor deletes nothing"


def test_no_orphan_warning_without_the_old_file(world):
    res = world.run("--no-network")
    res.expect_none("WARN", "orphan entry")
    res.expect_none("WARN", "orphan file")


@need_jq
def test_another_a2a_server_entry_in_the_global_file_is_an_orphan_warning(world):
    config = agy_config(
        "http://127.0.0.1:8120",
        world.agy_key,
        servers_after={"a2a-old": {"url": "http://127.0.0.1:8120/mcp"}, "a2a": {"url": "x"}, "obsidian": {"url": "y"}},
    )
    world.agy_file.write_text(json.dumps(config))
    res = world.run("--no-network", url="http://127.0.0.1:8120")
    res.expect("WARN", "orphan entry", "besides a2a-coord: a2a-old (remove it by hand")
    assert not res.has("WARN", "orphan entry", "obsidian") and not res.has("WARN", "orphan entry", "a2a-old a2a")


@need_jq
def test_an_orphan_name_that_holds_a_key_is_shown_with_the_key_hidden(world):
    config = agy_config("http://127.0.0.1:8120", world.agy_key, servers_after={f"a2a-{world.claude_key}": {"url": "x"}})
    world.agy_file.write_text(json.dumps(config))
    res = world.run("--no-network", url="http://127.0.0.1:8120")
    res.expect("WARN", "orphan entry", "a2ak_<hidden>")


@need_jq
def test_a_lone_a2a_coord_entry_is_not_an_orphan(world):
    res = world.run("--no-network", url="http://127.0.0.1:8120")
    res.expect_none("WARN", "orphan")


def test_without_jq_the_entry_and_orphans_are_found_by_text_and_the_url_check_is_skipped(world):
    path = nojq_path(world.tmp / "nojq")
    config = agy_config("http://127.0.0.1:8120", world.agy_key, servers_after={"a2a-old": {"url": "x"}})
    config["mcpServers"]["a2a-coord"]["url"] = "http://wrong.example/mcp"
    world.agy_file.write_text(json.dumps(config))
    res = world.run("--no-network", url="http://127.0.0.1:8120", PATH=f"{world.fakebin}:{path}")
    res.expect("INFO", "jq is not installed")
    res.expect("OK", "agy file has an a2a-coord server entry")
    res.expect("OK", "agy file holds an a2ak_ key")
    res.expect("WARN", "orphan entry", "a2a-old")
    res.expect_none("WARN", "agy entry url")
    world.agy_file.write_text(json.dumps({"mcpServers": {"obsidian": {}}}))
    res = world.run("--no-network", PATH=f"{world.fakebin}:{path}")
    res.expect("WARN", "agy entry not set up")


# ---- the server --------------------------------------------------------------------------------


def test_healthz_200_is_ok(world, stub):
    res = green(world, stub)
    res.expect("OK", f"GET {stub.url}/healthz answered 200")


@pytest.mark.parametrize("status", [500, 503, 404, 302, 401])
def test_healthz_with_another_status_is_a_fail_with_the_status_and_the_hint_and_no_probe(world, stub, status):
    ready(stub)
    stub.script("/healthz", Reply(status, "SERVERTEXT-do-not-print"))
    res = world.run(url=stub.url, extra_secrets=("SERVERTEXT",))
    res.expect("FAIL", f"answered {status}", stub.url, "docker compose", "plugins/coordination")
    assert res.code == 1
    assert stub.requests("/sessions") == [], "no probe when the server is not healthy"
    res.expect("INFO", "probe sessions skipped")
    assert "SERVERTEXT" not in res.out


def test_healthz_with_nothing_listening_is_a_fail_no_answer_and_fast(world):
    start = time.monotonic()
    url = f"http://127.0.0.1:{free_port()}"
    res = world.run(url=url)
    assert time.monotonic() - start < 4
    res.expect("FAIL", "no answer", url, "docker compose")
    assert res.code == 1


def test_a_slow_server_is_cut_at_5_seconds_and_reported_as_no_answer(world, stub):
    ready(stub)
    stub.script("/healthz", Reply(200, "{}", delay=7))
    start = time.monotonic()
    res = world.run(url=stub.url)
    elapsed = time.monotonic() - start
    assert 4.5 < elapsed < 9, elapsed
    res.expect("FAIL", "no answer")


def test_a_probe_that_hangs_is_cut_at_5_seconds_too(world, stub):
    ready(stub, claude=Reply(201, "{}", delay=7))
    start = time.monotonic()
    res = world.run(url=stub.url)
    assert time.monotonic() - start < 14
    res.expect("FAIL", "claude-code registration: no answer")


@need_jq
def test_every_call_is_bounded_and_ignores_proxies(world, stub):
    """A proxy variable must not send a probe (and its key) anywhere else: `--noproxy '*'`."""
    ready(stub)
    world.write_agy(stub.url)
    res = world.run(url=stub.url, HTTP_PROXY="http://127.0.0.1:1", http_proxy="http://127.0.0.1:1", ALL_PROXY="http://127.0.0.1:1")
    res.expect("OK", "healthz answered 200")
    res.expect("OK", "claude-code key accepted")


@pytest.mark.parametrize("status", [401, 403])
def test_a_rejected_claude_key_is_a_fail(world, stub, status):
    ready(stub, claude=Reply(status, "SERVERTEXT"))
    res = world.run(url=stub.url, extra_secrets=("SERVERTEXT",))
    res.expect("FAIL", "the server rejected the claude-code key", str(status), "expired or revoked, run key rotate")
    assert res.code == 1


@pytest.mark.parametrize("status", [410, 400, 409, 429, 500])
def test_another_probe_status_is_a_fail_with_the_status_only(world, stub, status):
    ready(stub, claude=Reply(status, '{"detail":"SERVERTEXT"}'))
    res = world.run(url=stub.url, extra_secrets=("SERVERTEXT",))
    res.expect("FAIL", "claude-code registration failed with status", str(status))
    assert "SERVERTEXT" not in res.out
    # a failed registration is not ended
    assert len(stub.requests("/sessions/end")) <= 1  # only the antigravity probe's


@pytest.mark.parametrize(
    "reply",
    [
        pytest.param(Reply(201, "not json"), id="not-json"),
        pytest.param(Reply(201, "{}"), id="no-handle"),
        pytest.param(Reply(201, '{"handle": "<script>alert(1)</script>"}'), id="html-handle"),
        pytest.param(Reply(201, '{"handle": "claude-code@box/UPPER~3f2a9c1d"}'), id="bad-name"),
        pytest.param(Reply(201, '{"handle": "claude-code@box/x~3f2a9c1"}'), id="short-sid"),
        pytest.param(Reply(201, '{"handle": "claude-code@box/x~3F2A9C1D"}'), id="upper-sid"),
        pytest.param(Reply(200, '{"handle": "claude-code@other/x~3f2a9c1d"}'), id="another-card"),
        pytest.param(Reply(200, '{"handle": "antigravity@box/x~3f2a9c1d"}'), id="another-harness"),
        pytest.param(Reply(201, '{"handle": "claude-code@box/x~3f2a9c1d\\nSERVERTEXT"}'), id="newline"),
    ],
)
def test_a_registration_without_a_valid_handle_for_this_card_is_a_fail_and_prints_nothing_of_the_server(world, stub, reply):
    ready(stub, claude=reply)
    res = world.run(url=stub.url, extra_secrets=("SERVERTEXT", "alert(1)"))
    res.expect("FAIL", "not with a valid handle for card")
    assert "<script>" not in res.out and "other" not in res.out.replace("another", "")
    assert res.code == 1


def test_a_probe_session_is_ended_and_a_failed_end_is_info(world, stub):
    ready(stub, end=Reply(404, "SERVERTEXT"))
    res = world.run(url=stub.url, extra_secrets=("SERVERTEXT",))
    res.expect("OK", "registered as")
    res.expect("INFO", "claude-code probe session could not be ended", "404")
    assert res.code in (0, 1) and not res.has("FAIL", "ended")


def test_the_end_request_is_not_sent_for_a_failed_registration(world, stub):
    ready(stub, claude=Reply(401, ""), agy_reply=Reply(401, ""))
    world.run(url=stub.url)
    assert stub.requests("/sessions/end") == []


def test_the_default_cards_are_computed_from_the_host_name_like_the_hook_scripts(world, stub):
    fake_tool(world.tmp / "host", "uname", 'echo "Box.Example.Org"\n')
    ready(stub)
    res = world.run(url=stub.url, A2A_CARD=None, A2A_AGY_CARD=None, PATH=f"{world.tmp / 'host'}:{world.fakebin}:{os.environ['PATH']}")
    res.expect("OK", "registered as", CLAUDE_HANDLE)
    res.expect("OK", "registered as", AGY_HANDLE)
    assert [json.loads(r.body)["card"] for r in stub.requests("/sessions")] == [CLAUDE_CARD, AGY_CARD]


def test_a_host_name_with_odd_characters_is_reduced_like_the_hooks_do(world, stub):
    fake_tool(world.tmp / "host", "uname", 'echo "My_Box.local"\n')
    ready(stub, claude=session_reply("claude-code@my-box/doctor-1~3f2a9c1d"), agy_reply=session_reply("antigravity@my-box/doctor-2~3f2a9c1e"))
    res = world.run(url=stub.url, A2A_CARD=None, A2A_AGY_CARD=None, PATH=f"{world.tmp / 'host'}:{world.fakebin}:{os.environ['PATH']}")
    assert [json.loads(r.body)["card"] for r in stub.requests("/sessions")] == ["claude-code@my-box", "antigravity@my-box"], res.out


@pytest.mark.parametrize("card", ["Claude-Code@box", "claude-code", "claude-code@", "@box", "claude code@box", "-x@box", "claude-code@bo_x", "a" * 40 + "@box"])
def test_an_invalid_claude_card_is_a_fail_and_not_probed(world, stub, card):
    ready(stub)
    res = world.run(url=stub.url, A2A_CARD=card)
    res.expect("FAIL", "claude-code card", "not a valid card", "set A2A_CARD")
    assert len(stub.requests("/sessions")) == 1  # antigravity's only


@pytest.mark.parametrize("card", ["claude-code@box", "antigravity", "antigravity@", "antigravity@Box", "antigravity@-x", "antigravity@bo_x", "antigravity@" + "a" * 33])
def test_an_invalid_agy_card_is_a_fail_and_not_probed(world, stub, card):
    ready(stub)
    res = world.run(url=stub.url, A2A_AGY_CARD=card)
    res.expect("FAIL", "antigravity card", "not a valid card", "set A2A_AGY_CARD")
    assert len(stub.requests("/sessions")) == 1  # claude-code's only


def test_with_no_usable_claude_key_only_the_agy_probe_runs(world, stub):
    ready(stub, claude=session_reply(AGY_HANDLE))  # the first registration is antigravity's now
    world.key_file.unlink()
    res = world.run(url=stub.url)
    res.expect("INFO", "claude-code probe skipped")
    res.expect("OK", "antigravity key accepted")
    assert [json.loads(r.body)["card"] for r in stub.requests("/sessions")] == [AGY_CARD]


def test_with_no_agy_key_only_the_claude_probe_runs(world, stub):
    ready(stub)
    world.agy_key_file.unlink()
    world.agy_file.unlink()
    res = world.run(url=stub.url)
    res.expect("INFO", "antigravity probe skipped")
    res.expect("OK", "claude-code key accepted")
    assert [json.loads(r.body)["card"] for r in stub.requests("/sessions")] == [CLAUDE_CARD]


@pytest.mark.parametrize("status", [401, 403])
def test_a_rejected_agy_key_is_a_fail_naming_agy(world, stub, status):
    ready(stub, agy_reply=Reply(status, ""))
    res = world.run(url=stub.url)
    res.expect("OK", "claude-code key accepted")
    res.expect("FAIL", "the server rejected the antigravity key", str(status), "expired or revoked, run key rotate")


def test_the_agy_key_is_the_first_a2ak_token_of_the_file_and_goes_to_the_server(world, stub):
    other = throwaway_key()
    world.agy_key_file.unlink()
    config = agy_config(stub.url, world.agy_key, servers_before={"first": {"headers": {"Authorization": f"Bearer {other}"}}})
    world.agy_file.write_text(json.dumps(config))
    ready(stub)
    world.run(url=stub.url, extra_secrets=tuple(key_parts(other)))
    assert stub.requests("/sessions")[1].headers["authorization"] == f"Bearer {other}"


# ---- secrets, writes, and the two harnesses that are never started -----------------------------


@pytest.mark.parametrize("which", ["claude", "agy"])
def test_a_key_is_never_in_any_process_argument_list_or_a_childs_environment(world, stub, which):
    """The sampler of the agy hook tests: while the doctor runs (the stub holds each answer for a
    while, so each curl lives long enough to be seen), no process's argument list holds the key and no
    descendant's environment holds it either, with `A2A_API_KEY` set in the doctor's own environment."""
    world.write_agy(stub.url)
    ready(stub)
    for path in ("/healthz", "/sessions", "/sessions/end"):
        replies = stub._scripts[path]
        for r in replies:
            r.delay = 0.3
    key = world.claude_key if which == "claude" else world.agy_key
    # No A2A_API_KEY in this environment: a forked subshell shows its parent's initial environment in
    # /proc, so the sampler cannot tell it from a child that really holds it. The test below, with a fake
    # curl and `A2A_API_KEY` set, covers that variable.
    env = world.env(stub.url, A2A_API_KEY=None)
    proc = subprocess.Popen([DASH, str(doctor_path())], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, cwd=world.cwd)
    hits, samples = agy.sample_for_secret(proc, key, interval=0.01)
    out, err = proc.communicate(timeout=30)
    assert samples >= 5, samples
    assert hits == [], hits
    assert proc.returncode == 0, out
    assert "registered as" in out and key not in out + err


@need_jq
def test_a_fake_curl_sees_the_key_on_stdin_only_and_every_call_is_bounded(world, tmp_path_factory):
    """A curl that records its argument list, its environment and its stdin: the key is on stdin
    (`-K -`), nowhere else, and every call has the options the hooks use."""
    log_dir = tmp_path_factory.mktemp("curlog")
    log = log_dir / "curl.log"
    body = (
        'for a; do last=$a; case $prev in --data) data=$a ;; esac; prev=$a; done\n'
        '{ printf "ARGV:"; for a; do printf " [%s]" "$a"; done; printf "\\n"; env | sed "s/^/ENV:/"; printf "STDIN:\\n"; cat; printf "\\nEND\\n"; } >> "$A2A_TEST_LOG"\n'
        'case $last in\n'
        '  */healthz) printf 200 ;;\n'
        '  */sessions/end) printf 200 ;;\n'
        '  */sessions) case $data in\n'
        '      *antigravity@box*) printf \'{"handle":"antigravity@box/doctor-2~3f2a9c1e"}\\n201\' ;;\n'
        '      *) printf \'{"handle":"claude-code@box/doctor-1~3f2a9c1d"}\\n201\' ;;\n'
        '    esac ;;\n'
        'esac\n'
    )
    fake_tool(world.tmp / "fakecurl", "curl", body)
    world.write_agy("http://127.0.0.1:8120")
    res = world.run(
        snap=False,
        url="http://127.0.0.1:8120",
        PATH=f"{world.tmp / 'fakecurl'}:{world.fakebin}:{os.environ['PATH']}",
        A2A_TEST_LOG=str(log),
    )
    text = log.read_text()
    assert res.has("OK", "claude-code key accepted")
    argv_lines = [line for line in text.splitlines() if line.startswith("ARGV:")]
    env_lines = [line for line in text.splitlines() if line.startswith("ENV:")]
    assert len(argv_lines) >= 5  # healthz, two registrations, two ends
    for secret in world.secrets:
        assert not any(secret in line for line in argv_lines), "a key is in a curl argument list"
        assert not any(secret in line for line in env_lines), "a key is in a curl environment"
    assert not any(line.startswith("ENV:A2A_API_KEY") for line in env_lines)
    for line in argv_lines:
        assert line.startswith("ARGV: [-q]"), line
        for part in ("[--proto] [=http,https]", "[--noproxy] [*]", "[--connect-timeout] [2]", "[--max-time] [5]"):
            assert part in line, (part, line)
    stdin_headers = re.findall(r'^header = "Authorization: Bearer (\S+)"$', text, re.MULTILINE)
    assert stdin_headers.count(world.claude_key) >= 2  # register and end
    assert any(h == world.agy_key for h in stdin_headers)
    assert all("-K" in line and "[-]" in line for line in argv_lines if "/healthz" not in line)
    assert not any("Authorization" in line for line in argv_lines)


@pytest.mark.parametrize("scenario", ["green", "no-key", "bad-url", "refused", "rejected"])
def test_the_doctor_writes_nothing_and_changes_nothing_under_the_temporary_tree(world, stub, scenario):
    """`World.run` compares the whole tree (HOME, TMPDIR, the working directory, the key files with
    their modes and mtimes) before and after; this runs it through every kind of outcome."""
    ready(stub)
    old = world.home / ".gemini" / "config" / "plugins" / "coordination" / "mcp_config.json"
    old.parent.mkdir(parents=True)
    old.write_text("{}")
    (world.cfg / "settings").mkdir()
    url = stub.url
    if scenario == "no-key":
        world.key_file.unlink()
    elif scenario == "bad-url":
        url = "ftp://nope"
    elif scenario == "refused":
        url = f"http://127.0.0.1:{free_port()}"
    elif scenario == "rejected":
        ready(stub, claude=Reply(401, ""), agy_reply=Reply(401, ""))
    world.key_file.chmod(0o644) if scenario == "green" and world.key_file.exists() else None
    before_key = world.key_file.stat().st_mtime_ns if world.key_file.exists() else None
    before_agy = world.agy_file.stat().st_mtime_ns
    world.run(url=url)
    assert not (world.tmpdir.exists() and any(world.tmpdir.iterdir())), "a temporary file was left"
    assert not any(world.cwd.iterdir())
    assert world.agy_file.stat().st_mtime_ns == before_agy
    if before_key is not None:
        assert world.key_file.stat().st_mtime_ns == before_key
    assert old.read_text() == "{}", "the orphan file is reported, never deleted"


def test_the_doctor_never_starts_agy_or_claude_even_with_both_on_the_path_first(world, stub):
    """`World.run` plants a fake `agy` and `claude` first on PATH and fails on a marker; this makes the
    point once more with the most thorough run, the fakes executable and `$0` visible."""
    for name in ("agy", "claude"):
        assert os.access(world.fakebin / name, os.X_OK)
    green(world, stub)
    assert list(world.markers.iterdir()) == []


def test_the_doctor_leaves_the_environment_variable_out_of_every_child(world, tmp_path_factory):
    """`A2A_API_KEY` is unset so no child sees it: a fake `sed` (run by the doctor) sees no such variable."""
    log_dir = tmp_path_factory.mktemp("envlog")
    log = log_dir / "env.log"
    fake_tool(world.tmp / "spy", "sed", f'env >> "$A2A_TEST_LOG"\nexec {shutil.which("sed")} "$@"\n')
    world.run(
        "--no-network",
        snap=False,
        PATH=f"{world.tmp / 'spy'}:{world.fakebin}:{os.environ['PATH']}",
        A2A_TEST_LOG=str(log),
        A2A_API_KEY="some-env-secret",
        extra_secrets=("some-env-secret",),
    )
    assert log.exists() and log.read_text()
    assert "A2A_API_KEY" not in log.read_text()


def test_an_imported_variable_of_the_same_name_as_a_secret_holder_does_not_reach_a_child(world, tmp_path_factory):
    log_dir = tmp_path_factory.mktemp("envlog2")
    log = log_dir / "env.log"
    fake_tool(world.tmp / "spy", "sed", f'env >> "$A2A_TEST_LOG"\nexec {shutil.which("sed")} "$@"\n')
    world.run(
        "--no-network",
        snap=False,
        PATH=f"{world.tmp / 'spy'}:{world.fakebin}:{os.environ['PATH']}",
        A2A_TEST_LOG=str(log),
        dr_ckey="imported",
        dr_atok="imported",
    )
    text = log.read_text()
    assert world.claude_key not in text and world.agy_key not in text
    assert "dr_ckey" not in text and "dr_atok" not in text


# ---- dash and bash --posix ---------------------------------------------------------------------


@need_jq
@pytest.mark.skipif(BASH is None, reason="bash is not installed")
def test_it_runs_under_bash_posix_and_prints_what_dash_prints(world, stub):
    world.write_agy(stub.url)
    ready(stub)
    dash = world.run(url=stub.url)
    ready(stub)
    bash = world.run(url=stub.url, runner=[BASH, "--posix"])
    assert bash.proc.returncode == dash.proc.returncode
    assert bash.out == dash.out


@pytest.mark.skipif(BASH is None, reason="bash is not installed")
def test_bash_posix_gives_the_same_output_for_a_broken_install(world, stub):
    world.key_file.write_text("nonsense\n")
    world.key_file.chmod(0o644)
    world.agy_file.chmod(0o666)
    (world.cfg / "settings").mkdir()
    ready(stub)
    dash = world.run(url=stub.url)
    ready(stub)
    bash = subprocess.run([BASH, "--posix", str(doctor_path())], capture_output=True, text=True, env=world.env(stub.url), cwd=world.cwd, check=False, timeout=60)
    assert bash.returncode == dash.code == 1
    assert bash.stdout == dash.out
    assert bash.stderr == ""


@pytest.mark.skipif(BASH is None, reason="bash is not installed")
def test_bash_posix_runs_the_usage_error_too(world):
    bash = subprocess.run([BASH, "--posix", str(doctor_path()), "--nope"], capture_output=True, text=True, env=world.env("http://127.0.0.1:1"), check=False, timeout=30)
    assert bash.returncode == 2 and bash.stdout == ""


# ---- the script itself --------------------------------------------------------------------------


def source_lines() -> list[str]:
    return doctor_path().read_text().splitlines()


def code() -> str:
    return "\n".join(line for line in source_lines() if not line.lstrip().startswith("#"))


def code_without_strings() -> str:
    text = re.sub(r"'[^']*'", "''", code())
    text = re.sub(r'"[^"]*"', '""', text)
    return text


def test_the_doctor_is_posix_sh_executable_and_not_a_hook_script():
    path = doctor_path()
    assert path.read_text().startswith("#!/bin/sh\n")
    assert os.access(path, os.X_OK)


def test_the_doctor_parses_under_dash():
    r = subprocess.run([DASH, "-n", str(doctor_path())], capture_output=True, text=True, check=False)
    assert r.returncode == 0, r.stderr


def test_the_doctor_is_shellcheck_clean_at_style_level():
    if shutil.which("shellcheck") is None:
        pytest.skip("shellcheck is not installed")
    r = subprocess.run(["shellcheck", "-s", "sh", "-S", "style", str(doctor_path())], capture_output=True, text=True, check=False)
    assert r.returncode == 0, r.stdout + r.stderr


def test_the_doctor_has_no_bashism():
    text = code_without_strings()
    for bashism in ("local ", "function ", "<<<", "&>", "${!", "declare ", "read -p", "echo -e", "==", "$RANDOM", "set -o pipefail", "<(", ">("):
        assert bashism not in text, bashism
    assert not re.search(r"^\s*source\s", text, re.MULTILINE)
    assert not re.search(r"\[\[(?!:)", text)
    assert not re.search(r"(?<!:)\]\]", text)


def test_the_doctor_reads_settings_like_the_hooks_do():
    text = code()
    assert "LC_ALL=C" in text
    assert re.search(r'\. "\$DIR/a2a-lib\.sh"', text) and "a2a_load_config" in text
    assert "unset A2A_API_KEY" in text
    assert "export" not in re.sub(r"export LC_ALL", "", code_without_strings()), "only LC_ALL is exported"
    names = ("A2A_SERVER_URL", "A2A_KEY_FILE", "A2A_CARD", "A2A_AGY_KEY_FILE", "A2A_AGY_CARD")
    lines = text.splitlines()
    loaded = next(i for i, line in enumerate(lines) if "a2a_load_config" in line)
    first_read = next(i for i, line in enumerate(lines) if any(f"${{{n}:-" in line for n in names))
    assert loaded < first_read


def curl_calls() -> list[str]:
    """Each curl invocation with its continuation lines."""
    calls: list[str] = []
    lines = code().splitlines()
    i = 0
    while i < len(lines):
        if re.search(r"\bcurl\b\s+-q", lines[i]):
            call = lines[i]
            while call.rstrip().endswith("\\") and i + 1 < len(lines):
                i += 1
                call += "\n" + lines[i]
            calls.append(call)
        i += 1
    return calls


def test_every_curl_call_is_bounded_protocol_limited_and_ignores_proxies():
    calls = curl_calls()
    assert len(calls) == 3, calls  # healthz, the probe registration, the probe end
    for call in calls:
        for needle in ("--proto '=http,https'", "--connect-timeout 2", "--max-time 5", "--noproxy '*'"):
            assert needle in call, (needle, call)
    bare = code_without_strings()
    for m in re.finditer(r"\bcurl\b", bare):
        assert bare[: m.start()].endswith("command -v ") or bare[m.end() :].startswith(" -q"), "every curl starts with -q"


def test_a_key_only_reaches_curl_on_stdin():
    text = code()
    assert not re.search(r"-H\s+['\"]?Authorization", text)
    assert "--header" not in text
    for call in curl_calls():
        assert not re.search(r"\s-u\s|--user|--oauth2", call), call
        if "/sessions" in call:
            assert "-K -" in call
    assert text.count('header = "Authorization: Bearer %s') == 2
    assert not re.search(r"echo[^\n]*\$(pr_key|dr_ckey|dr_atok)", text)


def test_nothing_in_the_doctor_writes_runs_the_harnesses_or_evaluates_text():
    bare = code_without_strings()
    assert not re.search(r"\b(chmod|chown|mkdir|touch|rm|mv|cp|tee|ln|install|dd|mktemp|truncate)\s", bare), "a command that writes"
    assert not re.search(r"\b(eval|exec|trap|set\s+-[a-z]*[eu])\b", bare)
    assert not re.search(r"(^|[\s;|&(])(agy|claude)(\s|$)", bare), "a harness command"
    targets = [t.rstrip(");") for t in re.findall(r"\d?>>?\s*(\S+)", bare)]
    assert set(targets) <= {"/dev/null", "&1", "&2"}, targets
    assert "sd -i" not in bare and "sed -i" not in bare


def test_every_key_holder_is_unset_before_it_is_assigned_and_no_secret_is_echoed():
    text = code()
    assert "unset dr_ckey dr_akey dr_hkey dr_fbtok dr_atok dr_etok dr_eauth dr_mcp_key dr_pkey pr_key" in text
    assert text.index("set +x") < text.index("unset A2A_API_KEY"), "set +x comes before anything that handles a key"
    for line in text.splitlines():
        if re.match(r"\s*(info|ok|warn|fail)\b", line):
            assert not re.search(r"\$\{?(dr_ckey|dr_akey|dr_hkey|dr_fbtok|dr_atok|dr_etok|dr_mcp_key|dr_pkey|pr_key|KEY)\b", line), line


def test_the_doctor_output_is_ascii_only_in_the_source_too():
    assert doctor_path().read_bytes().isascii()


# ---- review findings of PR #105 (Opus) ---------------------------------------------------------

HOLDERS = ("dr_ckey", "dr_akey", "dr_hkey", "dr_fbtok", "dr_atok", "dr_etok", "dr_eauth", "dr_mcp_key", "dr_pkey", "pr_key")


def test_no_imported_secret_holder_reaches_a_child_on_the_probe_path_either(world, stub, tmp_path_factory):
    """The first fix unset three of the five holders and the test only imported two of them with
    --no-network: `pr_key` (the raw key) and `dr_eauth` (the whole Bearer header value) stayed exported
    when imported, and every curl, grep and jq child received the key. All five names are imported here
    and the probe path runs against the stub."""
    log = tmp_path_factory.mktemp("envlog3") / "env.log"
    world.write_agy(stub.url)
    ready(stub)
    spies = world.tmp / "spies"
    for name in ("curl", "grep", "jq", "sed"):
        real = shutil.which(name)
        if real:
            fake_tool(spies, name, f'env >> "$A2A_TEST_LOG"\nexec {real} "$@"\n')
    imported = {name: "imported-" + name for name in HOLDERS}
    res = world.run(url=stub.url, snap=False, PATH=f"{spies}:{world.fakebin}:{os.environ['PATH']}", A2A_TEST_LOG=str(log), **imported)
    text = log.read_text()
    assert text, "the spies ran"
    for name in HOLDERS:
        assert f"{name}=" not in text, f"{name} reached a child"
    assert world.claude_key not in text and world.agy_key not in text, "a key reached a child's environment"
    assert res.count("OK") > 0


@pytest.mark.parametrize("flag", ["-x"])
def test_a_shell_trace_does_not_print_a_key(world, stub, flag):
    """`sh -x a2a-doctor` is what a user runs when a script misbehaves, and pastes into an issue."""
    world.write_agy(stub.url)
    ready(stub)
    res = world.run(url=stub.url, runner=[DASH, flag], snap=False)
    assert world.claude_key not in res.proc.stderr and world.agy_key not in res.proc.stderr
    assert world.claude_key not in res.out and world.agy_key not in res.out
    res = world.run("--no-network", runner=[DASH, flag], snap=False)
    assert world.claude_key not in res.proc.stderr and world.agy_key not in res.proc.stderr


def test_a_trace_in_shellopts_does_not_print_a_key_under_bash(world, stub):
    if BASH is None:
        pytest.skip("bash is not installed")
    world.write_agy(stub.url)
    ready(stub)
    res = world.run(url=stub.url, runner=[BASH, "--posix", "-x"], snap=False)
    assert world.claude_key not in res.proc.stderr and world.agy_key not in res.proc.stderr
