"""The admin socket: an in-container Unix domain socket, and nothing else (S1-ADMIN; spec 3.7, D15).

- Path `A2A_ADMIN_SOCKET` (`/run/a2a/admin.sock`, on the tmpfs of the compose file). Created with
  mode 0600 (the umask is narrowed while it is bound, so there is no instant at which it is more
  open) and removed when the server stops. A stale socket file from a crashed run is replaced; a
  file that is not a socket is never touched, and the server then refuses to start.
- **No TCP, no fallback.** This class opens one `AF_UNIX` listener. If it cannot, `start` raises and
  the server does not start: there is no other way in. The HTTP app has no admin route and the key
  scopes have no admin scope (`tests/test_admin_socket.py` checks all three).
- One request and one reply per connection (`protocol`). A client that sends nothing for
  `READ_TIMEOUT_S`, or a line over `MAX_LINE`, is dropped.
- The actor written to the audit log is `admin:uid<N>` from the peer's credentials (`SO_PEERCRED`),
  or `admin` where the kernel gives none. It says which operating-system user ran the command, not
  that a human did: see the real-terminal rule of spec 8.3.
- Requests, replies and their arguments are never logged: a reply to `key create` holds a secret.
  The log line carries the command name, the outcome code and the duration.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import socket
import stat
import struct
import time
from pathlib import Path

from coordination.admin.hooks import RevokeHooks
from coordination.admin.ops import AdminOps
from coordination.admin.protocol import MAX_LINE, AdminError, decode_request, encode_error, encode_ok

log = logging.getLogger("coordination.admin")

READ_TIMEOUT_S = 30.0
SOCKET_MODE = 0o600


class AdminServer:
    def __init__(self, path: str, ops: AdminOps, hooks: RevokeHooks | None = None) -> None:
        self._path = Path(path)
        self._ops = ops
        self._hooks = hooks if hooks is not None else RevokeHooks()
        self._server: asyncio.Server | None = None

    @property
    def path(self) -> Path:
        return self._path

    @property
    def hooks(self) -> RevokeHooks:
        """Where other streams register what a revocation must close (S1-WAKE: parked listeners)."""
        return self._hooks

    @property
    def listening(self) -> bool:
        return self._server is not None and self._server.is_serving()

    @property
    def server_sockets(self) -> list[socket.socket]:
        return list(self._server.sockets) if self._server is not None else []

    async def start(self) -> None:
        self._prepare_path()
        previous = os.umask(0o177)  # the socket file is created 0600, never wider
        try:
            self._server = await asyncio.start_unix_server(self._serve, path=str(self._path), limit=MAX_LINE)
        finally:
            os.umask(previous)
        os.chmod(self._path, SOCKET_MODE)  # belt and braces: the mode is a requirement, not a hope
        log.info("admin socket listening", extra={"fields": {"path": str(self._path)}})

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            with contextlib.suppress(Exception):
                await self._server.wait_closed()
            self._server = None
        with contextlib.suppress(FileNotFoundError):
            self._path.unlink()

    def _prepare_path(self) -> None:
        parent = self._path.parent
        parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        try:
            mode = self._path.lstat().st_mode
        except FileNotFoundError:
            return
        if not stat.S_ISSOCK(mode):
            raise RuntimeError(f"admin socket path {self._path} exists and is not a socket; refusing to replace it")
        self._path.unlink()  # a stale socket of a previous run

    async def _serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        started = time.monotonic()
        cmd, code = "?", "ok"
        try:
            try:
                line = await asyncio.wait_for(reader.readline(), READ_TIMEOUT_S)
            except (TimeoutError, ValueError, asyncio.LimitOverrunError):
                code = "bad_request"
                writer.write(encode_error(code, "no request line, or it is too long"))
                return
            if not line.endswith(b"\n"):
                code = "bad_request"
                writer.write(encode_error(code, "the request is not one complete line"))
                return
            try:
                cmd, args = decode_request(line)
                result = await self._ops.run(cmd, args, _actor(writer))
                writer.write(encode_ok(result))
            except AdminError as exc:
                code = exc.code
                writer.write(encode_error(exc.code, exc.message))
        except Exception as exc:  # noqa: BLE001 - never let one connection take the server down
            code = "internal"
            log.error("admin connection failed", extra={"fields": {"error": type(exc).__name__}})
            with contextlib.suppress(Exception):
                writer.write(encode_error(code, "the command failed; see the server log"))
        finally:
            with contextlib.suppress(Exception):
                await writer.drain()
                writer.close()
                await writer.wait_closed()
            log.info(
                "admin command",
                extra={"fields": {"cmd": cmd, "outcome": code, "ms": round((time.monotonic() - started) * 1000)}},
            )


def _actor(writer: asyncio.StreamWriter) -> str:
    sock = writer.get_extra_info("socket")
    try:
        creds = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
        _pid, uid, _gid = struct.unpack("3i", creds)
        return f"admin:uid{uid}"
    except (AttributeError, OSError, struct.error):
        return "admin"
