"""The client end of the admin socket (S1-ADMIN): connect, send one line, read one line."""

from __future__ import annotations

import socket
from typing import Any, Protocol

from coordination.admin.protocol import MAX_LINE, AdminError, decode_reply, encode_request

CONNECT_TIMEOUT_S = 5.0
REPLY_TIMEOUT_S = 60.0


class Unreachable(Exception):
    """The socket cannot be reached: not running here, wrong path, or no permission."""


class AdminClient(Protocol):
    def call(self, cmd: str, args: dict[str, Any] | None = None) -> dict[str, Any]:
        """Run a command and return its result. Raises `AdminError` (the server refused or failed)
        or `Unreachable`."""
        ...


class UnixClient:
    def __init__(self, path: str) -> None:
        self._path = path

    @property
    def path(self) -> str:
        return self._path

    def call(self, cmd: str, args: dict[str, Any] | None = None) -> dict[str, Any]:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            sock.settimeout(CONNECT_TIMEOUT_S)
            try:
                sock.connect(self._path)
            except FileNotFoundError:
                raise Unreachable(f"no admin socket at {self._path}; is the server running in this container?") from None
            except PermissionError:
                raise Unreachable(f"no permission to use the admin socket at {self._path} (it is mode 0600)") from None
            except OSError as exc:
                raise Unreachable(f"cannot connect to {self._path}: {exc.strerror or type(exc).__name__}") from None
            sock.settimeout(REPLY_TIMEOUT_S)
            sock.sendall(encode_request(cmd, args))
            buf = bytearray()
            while b"\n" not in buf:
                try:
                    chunk = sock.recv(65536)
                except TimeoutError:
                    raise AdminError("timeout", "the server did not answer in time") from None
                if not chunk:
                    break
                buf += chunk
                if len(buf) > MAX_LINE:
                    raise AdminError("bad_reply", "the server's reply is too long")
        finally:
            sock.close()
        if b"\n" not in buf:
            raise AdminError("bad_reply", "the server closed the connection without a complete reply")
        return decode_reply(bytes(buf).split(b"\n", 1)[0])
