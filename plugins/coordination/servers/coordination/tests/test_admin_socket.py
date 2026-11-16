"""The admin socket (S1-ADMIN): an in-container Unix socket, mode 0600, no TCP fallback, and no admin
route or scope on the HTTP side (spec 3.7, decision D15). No database: the server runs over a fake
command table; the real commands are tested in `test_admin_keys.py` and `test_admin_pg.py`."""

from __future__ import annotations

import asyncio
import json
import os
import socket
import stat
from pathlib import Path
from typing import Any

import pytest

from auth_helpers import add_key, bearer, client_for, make_config, probe_app
from conftest import run
from coordination.admin.protocol import COMMANDS, AdminError, decode_reply, decode_request, encode_request
from coordination.admin.server import AdminServer
from coordination.app import create_app
from coordination.auth import SCOPES, InMemoryApiKeyStore
from coordination.cli.client import Unreachable, UnixClient


class FakeOps:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any], str]] = []

    async def run(self, cmd: str, args: dict[str, Any], actor: str) -> dict[str, Any]:
        self.calls.append((cmd, dict(args), actor))
        if cmd == "boom":
            raise RuntimeError("secret detail must not reach the client")
        if cmd == "refuse":
            raise AdminError("refused", "no")
        return {"echo": cmd, "args": args}


async def raw(path: Path, payload: bytes, *, half_close: bool = True) -> bytes:
    reader, writer = await asyncio.open_unix_connection(str(path))
    writer.write(payload)
    await writer.drain()
    if half_close:
        writer.write_eof()
    data = await reader.read()
    writer.close()
    return data


def test_the_socket_is_mode_0600_unix_only_and_removed_on_stop(sock_dir):
    path = sock_dir / "run" / "admin.sock"  # the parent directory is created too

    async def go():
        server = AdminServer(str(path), FakeOps())  # type: ignore[arg-type]
        await server.start()
        try:
            mode = stat.S_IMODE(path.stat().st_mode)
            families = {s.family for s in server.server_sockets}
            parent_mode = stat.S_IMODE(path.parent.stat().st_mode)
            ok = decode_reply(await raw(path, encode_request("status")))
            return mode, families, parent_mode, ok, server.listening
        finally:
            await server.stop()

    mode, families, parent_mode, ok, listening = run(go())
    assert mode == 0o600
    assert families == {socket.AF_UNIX}  # no TCP, no fallback: the only listener is a Unix socket
    assert parent_mode == 0o700
    assert ok == {"echo": "status", "args": {}} and listening is True
    assert not path.exists()


def test_the_socket_is_never_created_wider_than_0600_whatever_the_umask(sock_dir):
    path = sock_dir / "admin.sock"
    previous = os.umask(0o000)
    try:

        async def go():
            server = AdminServer(str(path), FakeOps())  # type: ignore[arg-type]
            await server.start()
            try:
                return stat.S_IMODE(path.stat().st_mode)
            finally:
                await server.stop()

        assert run(go()) == 0o600
    finally:
        os.umask(previous)


def test_a_stale_socket_is_replaced_and_a_regular_file_is_never_touched(sock_dir):
    stale = sock_dir / "stale.sock"
    s = socket.socket(socket.AF_UNIX)
    s.bind(str(stale))
    s.close()  # the file stays: a crashed run

    async def start_stop(path):
        server = AdminServer(str(path), FakeOps())  # type: ignore[arg-type]
        await server.start()
        await server.stop()

    run(start_stop(stale))  # replaced without complaint
    not_a_socket = sock_dir / "file"
    not_a_socket.write_text("keep me")
    with pytest.raises(RuntimeError, match="not a socket"):
        run(start_stop(not_a_socket))
    assert not_a_socket.read_text() == "keep me"


def test_the_server_does_not_start_when_the_socket_cannot_be_opened(sock_dir):
    too_long = sock_dir / ("x" * 120) / "admin.sock"  # over the AF_UNIX path limit: there is no fallback to anything else
    with pytest.raises((OSError, RuntimeError, ValueError)):
        run(AdminServer(str(too_long), FakeOps()).start())  # type: ignore[arg-type]


def test_one_request_one_reply_and_the_actor_is_the_peer_uid(sock_dir):
    path = sock_dir / "admin.sock"
    ops = FakeOps()

    async def go():
        server = AdminServer(str(path), ops)  # type: ignore[arg-type]
        await server.start()
        try:
            return decode_reply(await raw(path, encode_request("key.list", {"a": 1})))
        finally:
            await server.stop()

    assert run(go()) == {"echo": "key.list", "args": {"a": 1}}
    assert ops.calls == [("key.list", {"a": 1}, f"admin:uid{os.getuid()}")]


@pytest.mark.parametrize(
    ("payload", "code"),
    [
        (b"not json\n", "bad_request"),
        (b'{"cmd": 3}\n', "bad_request"),
        (b'{"cmd": "x", "args": []}\n', "bad_request"),
        (b'{"cmd": "x"}', "bad_request"),  # no newline: not a complete line
        (b"", "bad_request"),
    ],
)
def test_malformed_requests_get_a_constant_error(sock_dir, payload, code):
    path = sock_dir / "admin.sock"

    async def go():
        server = AdminServer(str(path), FakeOps())  # type: ignore[arg-type]
        await server.start()
        try:
            return await raw(path, payload)
        finally:
            await server.stop()

    with pytest.raises(AdminError) as e:
        decode_reply(run(go()))
    assert e.value.code == code


def test_a_failing_command_never_leaks_its_detail_and_the_server_keeps_serving(sock_dir):
    path = sock_dir / "admin.sock"

    async def go():
        server = AdminServer(str(path), FakeOps())  # type: ignore[arg-type]
        await server.start()
        try:
            boom = await raw(path, encode_request("boom"))
            refuse = await raw(path, encode_request("refuse"))
            huge = await raw(path, b'{"cmd":"' + b"x" * 400_000 + b'"}\n')
            ok = await raw(path, encode_request("status"))
            return boom, refuse, huge, ok
        finally:
            await server.stop()

    boom, refuse, huge, ok = run(go())
    assert b"secret detail" not in boom and json.loads(boom)["error"]["code"] == "internal"
    assert json.loads(refuse)["error"] == {"code": "refused", "message": "no"}
    assert json.loads(huge)["error"]["code"] == "bad_request"
    assert json.loads(ok)["ok"] is True


def test_the_client_reports_an_unreachable_socket_plainly(sock_dir):
    with pytest.raises(Unreachable, match="no admin socket"):
        UnixClient(str(sock_dir / "missing.sock")).call("status")
    blocked = sock_dir / "dir"
    blocked.mkdir()
    with pytest.raises(Unreachable):
        UnixClient(str(blocked)).call("status")  # a directory is not a socket


def test_the_client_talks_to_the_server_over_the_socket(sock_dir):
    path = sock_dir / "admin.sock"

    async def go():
        server = AdminServer(str(path), FakeOps())  # type: ignore[arg-type]
        await server.start()
        try:
            ok = await asyncio.to_thread(UnixClient(str(path)).call, "status", {"x": 1})
            try:
                await asyncio.to_thread(UnixClient(str(path)).call, "refuse")
            except AdminError as exc:
                return ok, exc
        finally:
            await server.stop()

    ok, exc = run(go())
    assert ok == {"echo": "status", "args": {"x": 1}} and (exc.code, exc.message) == ("refused", "no")


def test_the_command_list_is_closed_and_has_no_expose_check_or_admin_apply():
    assert set(COMMANDS) == {
        "key.create", "key.list", "key.rotate", "key.revoke",
        "review.list", "review.show", "review.release", "review.deny",
        "status", "card.check",
    }  # fmt: skip
    with pytest.raises(AdminError):
        decode_request(b'[]')


# -- the HTTP side has no admin route and no admin scope ------------------------------------


def test_there_is_no_admin_http_route_and_no_admin_scope():
    assert set(SCOPES) == {"local-harness", "remote-peer", "status-client"}
    store = InMemoryApiKeyStore()
    tokens = {scope: add_key(store, scope, **extra) for scope, extra in (
        ("local-harness", {"card_id": "claude-code@box"}),
        ("remote-peer", {"peer_id": "p", "cards_allowed": ("claude-code@box",)}),
        ("status-client", {}),
    )}  # fmt: skip
    config = make_config(status_enabled=True)
    for app in (probe_app(config, store), create_app(config, key_store=store, admin=None)):
        client = client_for(app)
        for path in ("/admin", "/admin/", "/admin/keys", "/admin/key/create", "/a2a-coord/admin", "/v1/admin"):
            for method in ("GET", "POST", "DELETE", "PUT"):
                for headers in ({}, *(bearer(t) for t in tokens.values())):
                    response = client.request(method, path, headers=headers)
                    assert response.status_code == 404, (method, path, response.status_code)
    # And no route of the real app mentions it at all.
    routes = [getattr(r, "path", "") for r in create_app(config, key_store=store).routes]
    assert not [r for r in routes if "admin" in r]


def test_build_server_app_serves_http_on_its_listener_only_and_the_socket_is_a_separate_unix_listener():
    """The server module opens the Unix socket through `AdminServer` and nothing in `admin/` opens a
    TCP listener: no `start_server`, no `AF_INET`, no `uvicorn`, no `host`/`port` argument."""
    root = Path(__file__).resolve().parents[1] / "src" / "coordination" / "admin"
    text = "\n".join(p.read_text() for p in root.glob("*.py"))
    for forbidden in ("start_server(", "AF_INET", "uvicorn", "create_server(", "0.0.0.0", "127.0.0.1"):
        assert forbidden not in text, forbidden
    assert text.count("start_unix_server(") == 1
