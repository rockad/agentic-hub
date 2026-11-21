"""Builders shared by the S1-CLAUDE tests: the shell scripts of `plugins/coordination/bin/` run as a
hook would run them (hook JSON on stdin, a minimal environment), against

- a tiny stub HTTP server (`StubServer`) for the status codes and shapes the real server cannot
  easily produce, and
- the real app on a real socket (`tests/test_hooks_e2e.py`).

The scripts live outside `src/` and `tests/`, and the Docker image build runs the suite with only
those two directories: `plugin_file` skips when a script is absent (decision of the task rules, see
conftest's `PLUGIN_DIR`). Nothing here starts `claude` or `agy`; hook input is piped in as JSON.

Keys are throwaway: `make_key_file` writes a random value of the right shape to a mode-0600 file in
a pytest temp directory. No key is ever printed.
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import signal
import subprocess
import threading
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from conftest import PLUGIN_DIR, free_port

SID = "3f2a9c1d-0000-4000-8000-00000000abcd"
SID8 = "3f2a9c1d"
CARD = "claude-code@box"
HANDLE = f"{CARD}/agents-52~{SID8}"
DASH = shutil.which("dash") or "/usr/bin/dash"


def plugin_file(rel: str) -> Path:
    path = PLUGIN_DIR / rel
    if not path.exists():
        pytest.skip(f"{rel} is not in this tree: the image build runs the suite with only src/ and tests/")
    return path


def need_tools() -> None:
    for tool in ("curl", DASH):
        if shutil.which(tool) is None and not Path(tool).exists():
            pytest.skip(f"{tool} is not installed")


def make_key_file(directory: Path, key: str | None = None) -> tuple[Path, str]:
    """A mode-0600 key file with a throwaway key of the issued shape `a2ak_<env>_<keyid>_<secret>`."""
    key = key or f"a2ak_test_{secrets.token_hex(4)}_{secrets.token_urlsafe(24)}"
    path = directory / "api-key"
    path.write_text(key + "\n")
    path.chmod(0o600)
    return path, key


def hook_json(event: str, sid: str = SID, **extra: object) -> str:
    return json.dumps({"session_id": sid, "hook_event_name": event, **extra})


def base_env(tmp: Path, url: str, key_file: Path, **extra: str) -> dict[str, str]:
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": str(tmp / "home"),
        "LANG": "C",
        "A2A_KEY_FILE": str(key_file),
        "A2A_SERVER_URL": url,
        "A2A_CARD": CARD,
        "A2A_STATE_DIR": str(tmp / "state"),
        "CLAUDE_CODE_SESSION_ATTENDED": "1",
    }
    env.update(extra)
    return env


def run_script(
    script: Path, args: Iterable[str] = (), *, stdin: str = "", env: dict[str, str], timeout: float = 30
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [DASH, str(script), *args], input=stdin, capture_output=True, text=True, env=env, timeout=timeout, check=False
    )


def start_script(script: Path, args: Iterable[str] = (), *, stdin: str = "", env: dict[str, str]) -> subprocess.Popen[str]:
    proc = subprocess.Popen(
        [DASH, str(script), *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env
    )
    assert proc.stdin is not None
    proc.stdin.write(stdin)
    proc.stdin.close()
    return proc


def wait_for(predicate: Callable[[], object], timeout: float = 10.0, what: str = "the condition") -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError(f"timed out after {timeout} s waiting for {what}")


# ---- /proc helpers ----------------------------------------------------------------------------


def ppid_of(pid: int) -> int | None:
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return None
    return int(stat.rsplit(")", 1)[1].split()[1])


def children_of(pid: int) -> list[int]:
    found = []
    for entry in Path("/proc").iterdir():
        if entry.name.isdigit() and ppid_of(int(entry.name)) == pid:
            found.append(int(entry.name))
    return found


def descendants_of(pid: int) -> list[int]:
    out: list[int] = []
    todo = [pid]
    while todo:
        for child in children_of(todo.pop()):
            out.append(child)
            todo.append(child)
    return out


def cmdline_of(pid: int) -> bytes:
    try:
        return Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return b""


def environ_of(pid: int) -> bytes:
    try:
        return Path(f"/proc/{pid}/environ").read_bytes()
    except OSError:
        return b""


def comm_of(pid: int) -> str:
    try:
        return Path(f"/proc/{pid}/comm").read_text().strip()
    except OSError:
        return ""


def pid_alive(pid: int) -> bool:
    state = ""
    try:
        for line in Path(f"/proc/{pid}/status").read_text().splitlines():
            if line.startswith("State:"):
                state = line.split()[1]
    except OSError:
        return False
    return state not in ("Z", "X", "")


def processes_with_bytes_in_cmdline(needle: bytes) -> list[int]:
    hits = []
    for entry in Path("/proc").iterdir():
        if entry.name.isdigit() and needle in cmdline_of(int(entry.name)):
            hits.append(int(entry.name))
    return hits


def find_curl_child(script_pid: int, timeout: float = 10.0) -> int:
    holder: list[int] = []

    def seen() -> bool:
        for pid in descendants_of(script_pid):
            if comm_of(pid) == "curl":
                holder.append(pid)
                return True
        return False

    wait_for(seen, timeout, "the listener's curl child")
    return holder[0]


def kill_quietly(proc: subprocess.Popen) -> None:
    if proc.poll() is None:
        try:
            proc.send_signal(signal.SIGKILL)
        except ProcessLookupError:
            pass
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass


# ---- the stub server --------------------------------------------------------------------------


@dataclass
class Reply:
    status: int = 200
    body: str | bytes = ""
    headers: dict[str, str] = field(default_factory=dict)
    delay: float = 0.0  # seconds the stub holds the request before it answers


@dataclass
class Seen:
    method: str
    path: str
    headers: dict[str, str]
    body: str
    at: float


class StubServer:
    """Answers each request with the next `Reply` of its script (the last one repeats). Records every
    request, headers lower-cased. A parked request is a `Reply` with a `delay`."""

    def __init__(self) -> None:
        self.port = free_port()
        self.seen: list[Seen] = []
        self._scripts: dict[str, list[Reply]] = {}
        self._lock = threading.Lock()
        stub = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args: object) -> None:  # silence
                pass

            def _serve(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length).decode("utf-8", "replace") if length else ""
                path = self.path
                headers = {k.lower(): v for k, v in self.headers.items()}
                with stub._lock:
                    stub.seen.append(Seen(self.command, path, headers, body, time.monotonic()))
                    script = stub._scripts.get(path.split("?")[0]) or [Reply(404)]
                    reply = script.pop(0) if len(script) > 1 else script[0]
                if reply.delay:
                    time.sleep(reply.delay)
                data = reply.body.encode() if isinstance(reply.body, str) else reply.body
                try:
                    self.send_response(reply.status)
                    for k, v in reply.headers.items():
                        self.send_header(k, v)
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            do_GET = do_POST = _serve

        self.httpd = ThreadingHTTPServer(("127.0.0.1", self.port), Handler)
        self.httpd.daemon_threads = True
        self.thread = threading.Thread(target=lambda: self.httpd.serve_forever(poll_interval=0.02), daemon=True)
        self.thread.start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def script(self, path: str, *replies: Reply) -> None:
        with self._lock:
            self._scripts[path] = list(replies)

    def requests(self, path: str | None = None) -> list[Seen]:
        with self._lock:
            return [s for s in self.seen if path is None or s.path.split("?")[0] == path]

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


def session_reply(handle: str = HANDLE, status: int = 201) -> Reply:
    body = json.dumps({"handle": handle, "card": handle.split("/")[0], "created": True, "bind_with": "a2a_hello", "aliases": []})
    return Reply(status, body, {"Content-Type": "application/json"})


def listen_reply(status: int, body: str = "", **headers: str) -> Reply:
    return Reply(status, body, dict(headers))


# ---- fixtures (import them into a test module) ------------------------------------------------


@pytest.fixture
def stub():
    need_tools()
    server = StubServer()
    try:
        yield server
    finally:
        server.close()


@pytest.fixture
def hook_env(tmp_path):
    """A function: `hook_env(url, **extra)` gives the environment of a hook run, with a throwaway key
    file; the key is on the function as `.key` and the state directory as `.state`."""
    (tmp_path / "home").mkdir()
    key_file, key = make_key_file(tmp_path)

    def make(url: str, **extra: str) -> dict[str, str]:
        return base_env(tmp_path, url, key_file, **extra)

    make.key = key  # type: ignore[attr-defined]
    make.key_file = key_file  # type: ignore[attr-defined]
    make.state = tmp_path / "state"  # type: ignore[attr-defined]
    make.tmp = tmp_path  # type: ignore[attr-defined]
    return make
