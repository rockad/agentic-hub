"""The refusal logic of `a2a-coord` on a real pseudo-terminal (S1-ADMIN; spec 8.3).

`pty` is used only here, only for the refusals: a command that needs a terminal run with a pipe on
stdin or stdout, with an agent-session marker set, and with a wrong typed phrase. In each case a
fake admin socket records what reached it, and the assertion is that nothing that changes state did.
The paths that DO succeed on a real terminal (the secret printed once, a correct phrase) are run by
hand by the user: see "Hand-run steps" in `docs/specs/admin.md`.

The child runs `python -m coordination.cli` with a clean environment built here, because the
environment of the test run may itself carry agent-session variables.
"""

from __future__ import annotations

import json
import os
import pty
import select
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

TASK = "0f1e2d3c-4b5a-4968-8776-655443abcdef"
HELD = {
    "task_id": TASK, "peer": "peer:acme", "card": "claude-code@box", "to_handle": None, "received_at": None,
    "expires_at": None, "size_bytes": 3, "frame": {"untrusted": True, "tasks": []},
}  # fmt: skip


def _pty_available() -> bool:
    try:
        master, slave = pty.openpty()
    except OSError:
        return False
    os.close(master)
    os.close(slave)
    return True


pytestmark = pytest.mark.skipif(not _pty_available(), reason="no pseudo-terminal in this environment")


class FakeAdminSocket:
    """A listening Unix socket in a thread. Records the command of every connection and answers
    `review.show`; any other command gets `{}`."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.commands: list[str] = []
        self._sock = socket.socket(socket.AF_UNIX)
        self._sock.bind(str(path))
        self._sock.listen(4)
        self._sock.settimeout(0.1)
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self) -> None:
        while not self._stop.is_set():
            try:
                conn, _ = self._sock.accept()
            except (TimeoutError, OSError):
                continue
            with conn:
                data = b""
                while not data.endswith(b"\n"):
                    chunk = conn.recv(65536)
                    if not chunk:
                        break
                    data += chunk
                try:
                    cmd = json.loads(data)["cmd"]
                except (ValueError, KeyError):
                    cmd = "?"
                self.commands.append(cmd)
                result = HELD if cmd == "review.show" else {}
                conn.sendall(json.dumps({"ok": True, "result": result}).encode() + b"\n")

    def close(self) -> None:
        self._stop.set()
        self._thread.join(timeout=2)
        self._sock.close()


def clean_env(sock: Path, **extra: str) -> dict[str, str]:
    return {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8", "A2A_ADMIN_SOCKET": str(sock), **extra}


def cli_argv(*args: str) -> list[str]:
    return [sys.executable, "-m", "coordination.cli", *args]


def drive(fd: int, proc: subprocess.Popen, *, wait_for: bytes | None = None, answer: bytes | None = None, timeout: float = 20.0) -> tuple[int, str]:
    """Read the child's terminal until it exits; after `wait_for` appears, type `answer`."""
    deadline = time.monotonic() + timeout
    seen = b""
    answered = answer is None
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.2)
        if ready:
            try:
                chunk = os.read(fd, 4096)
            except OSError:  # EIO: the child closed its end
                break
            if not chunk:
                break
            seen += chunk
            if not answered and wait_for is not None and wait_for in seen:
                os.write(fd, answer or b"")
                answered = True
        elif proc.poll() is not None:
            break
    else:
        proc.kill()
        proc.wait()
        raise AssertionError(f"the child did not finish; output so far: {seen!r}")
    return proc.wait(timeout=10), seen.decode(errors="replace")


#: Runs in the child before the command: make the terminal on stdin its controlling terminal, so
#: `/dev/tty` opens, as it does under `docker exec -it`. Then replace itself with the command.
_BOOTSTRAP = "import fcntl, os, sys, termios; fcntl.ioctl(0, termios.TIOCSCTTY, 0); os.execv(sys.argv[1], sys.argv[1:])"


def spawn_on_pty(argv: list[str], env: dict[str, str]) -> tuple[subprocess.Popen, int]:
    """The command with a pseudo-terminal as stdin, stdout, stderr and controlling terminal."""
    master, slave = pty.openpty()
    try:
        proc = subprocess.Popen(
            [sys.executable, "-c", _BOOTSTRAP, *argv], stdin=slave, stdout=slave, stderr=slave,
            env=env, start_new_session=True, close_fds=True,
        )  # fmt: skip
    finally:
        os.close(slave)
    return proc, master


@pytest.fixture
def fake_socket(sock_dir):
    server = FakeAdminSocket(sock_dir / "admin.sock")
    try:
        yield server
    finally:
        server.close()


KEY_CREATE = ("key", "create", "--scope", "local-harness", "--agent", "claude-code@box", "--expires", "30d")


@pytest.mark.parametrize("marker", ["CLAUDE_CODE_SESSION_ATTENDED", "CLAUDECODE", "CI", "ANTIGRAVITY_X", "AGY_X"])
@pytest.mark.parametrize("argv", [KEY_CREATE, ("review", "show", TASK), ("review", "release", TASK)], ids=["key create", "review show", "review release"])
def test_on_a_real_terminal_an_agent_session_marker_still_refuses(fake_socket, marker, argv):
    proc, fd = spawn_on_pty(cli_argv(*argv), clean_env(fake_socket.path, **{marker: "0"}))
    code, output = drive(fd, proc, wait_for=b"Type '", answer=b"release abcdef\n")
    os.close(fd)
    assert code == 1 and marker in output and "agent-session" in output
    assert fake_socket.commands == []  # the server was never contacted


@pytest.mark.parametrize("argv", [KEY_CREATE, ("review", "show", TASK), ("review", "release", TASK), ("review", "deny", TASK)], ids=lambda a: " ".join(a[:2]))
def test_a_pipe_on_stdin_refuses_even_with_a_terminal_on_stdout(fake_socket, argv):
    master, slave = pty.openpty()
    try:
        proc = subprocess.Popen(
            cli_argv(*argv), stdin=subprocess.PIPE, stdout=slave, stderr=slave, env=clean_env(fake_socket.path), close_fds=True
        )
        proc.stdin.write(b"release abcdef\n")  # an answer piped in is not an answer
        proc.stdin.close()
        assert proc.wait(timeout=20) == 1
        os.close(slave)
        slave = -1
        text = os.read(master, 8192).decode(errors="replace")
    finally:
        os.close(master)
        if slave != -1:
            os.close(slave)
    assert "terminal" in text and "-it" in text
    assert fake_socket.commands == []


@pytest.mark.parametrize("argv", [KEY_CREATE, ("review", "show", TASK), ("review", "release", TASK)], ids=lambda a: " ".join(a[:2]))
def test_a_pipe_on_stdout_refuses_even_with_a_terminal_on_stdin(fake_socket, argv):
    master, slave = pty.openpty()
    try:
        proc = subprocess.Popen(
            cli_argv(*argv), stdin=slave, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=clean_env(fake_socket.path), close_fds=True
        )
        stdout, stderr = proc.communicate(timeout=20)
    finally:
        os.close(master)
        os.close(slave)
    assert proc.returncode == 1 and stdout == b""  # nothing, in particular no secret, went into the pipe
    assert b"terminal" in stderr
    assert fake_socket.commands == []


@pytest.mark.parametrize("typed", [b"release 000000\n", b"\n", b"release\n", b"yes\n", b"deny abcdef\n"])
def test_release_with_a_wrong_phrase_on_a_real_terminal_does_nothing(fake_socket, typed):
    proc, fd = spawn_on_pty(cli_argv("review", "release", TASK), clean_env(fake_socket.path))
    code, output = drive(fd, proc, wait_for=b"Type 'release abcdef'", answer=typed)
    os.close(fd)
    assert code == 1 and "did not match" in output
    assert fake_socket.commands == ["review.show"]  # the summary was fetched; the release was never sent


def test_deny_with_the_release_phrase_on_a_real_terminal_does_nothing(fake_socket):
    proc, fd = spawn_on_pty(cli_argv("review", "deny", TASK), clean_env(fake_socket.path))
    code, output = drive(fd, proc, wait_for=b"Type 'deny abcdef'", answer=b"release abcdef\n")
    os.close(fd)
    assert code == 1 and "did not match" in output
    assert fake_socket.commands == ["review.show"]
