"""S1-MCP end to end: a real uvicorn process-in-a-thread serving `build_server_app` (the app `main`
serves: the real middleware over the SQL key store, the real service layer, the real audit store, a
real Postgres), driven over real sockets by the official `mcp` client (dev dependency).

The official client opens with `server/discover` and falls back to `initialize`, as Claude Code and
agy do (SP5 D12), so this is the closest check on the wire that does not need either harness. It is
not a run against Claude Code or agy themselves; that stays unverified (see the S1-MCP caveats).
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from collections.abc import Iterator
from contextlib import asynccontextmanager

import httpx
import pytest
import uvicorn
from conftest import free_port, run
from mcp_helpers import CARD_AGY, CARD_CLAUDE, NOT_BOUND, agy_meta, make_env

from coordination.app import build_server_app

mcp_client = pytest.importorskip("mcp.client")
from mcp.client import Client  # noqa: E402
from mcp.client.streamable_http import streamable_http_client  # noqa: E402
from mcp.shared._httpx_utils import create_mcp_http_client  # noqa: E402


class Served:
    def __init__(self, env, port: int, methods: list[str]) -> None:
        self.env, self.port, self.methods = env, port, methods
        self.url = f"http://127.0.0.1:{port}"


class Recorder:
    """Passes everything through and notes the JSON-RPC method of each `/mcp` POST, in order."""

    def __init__(self, app, methods: list[str]) -> None:
        self.app, self.methods = app, methods

    def __getattr__(self, name: str):
        return getattr(self.app, name)

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http" or scope["path"] != "/mcp" or scope["method"] != "POST":
            return await self.app(scope, receive, send)
        message = await receive()
        try:
            self.methods.append(json.loads(message.get("body", b"") or b"{}").get("method", "?"))
        except ValueError:
            self.methods.append("?")
        replayed = False

        async def replay():
            nonlocal replayed
            if not replayed:
                replayed = True
                return message
            return await receive()

        await self.app(scope, replay, send)


@pytest.fixture
def served(pg_db) -> Iterator[Served]:
    port = free_port()
    env = make_env(pg_db, allowed_hosts=(f"127.0.0.1:{port}",), listen=f"127.0.0.1:{port}")
    methods: list[str] = []
    app = Recorder(build_server_app(env.config), methods)  # the app `main` serves
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_config=None, lifespan="on"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 20
    while not server.started:
        assert thread.is_alive() and time.monotonic() < deadline, "the server did not start"
        time.sleep(0.05)
    try:
        yield Served(env, port, methods)
    finally:
        server.should_exit = True
        thread.join(timeout=20)
        run(env.engine.dispose())


@asynccontextmanager
async def official_client(served: Served, token: str):
    http = create_mcp_http_client(headers={"Authorization": f"Bearer {token}"})
    async with http:
        async with Client(streamable_http_client(f"{served.url}/mcp", http_client=http)) as client:
            yield client


def text_of(result) -> str:
    return result.content[0].text


def test_the_official_client_connects_binds_and_exchanges_a_task_between_both_harnesses(served):
    keys = served.env.keys

    async def scenario() -> None:
        async with official_client(served, keys.claude) as claude, official_client(served, keys.agy) as agy:
            tools = await claude.list_tools()
            assert len(tools.tools) == 10
            # The client really opened with `server/discover` and fell back to `initialize`.
            assert "server/discover" in served.methods and "initialize" in served.methods
            assert served.methods.index("server/discover") < served.methods.index("initialize")

            # Claude: not bound until a2a_hello (the discover override gave it a stateful session).
            unbound = await claude.call_tool("a2a_inbox", {})
            assert unbound.is_error and text_of(unbound) == NOT_BOUND
            hello = await claude.call_tool("a2a_hello", {"name": "e2e"})
            claude_handle = json.loads(text_of(hello))["handle"]
            assert claude_handle.startswith(f"{CARD_CLAUDE}/e2e~")

            # agy: bound by conversation id on each call, never by the session; no hello needed.
            conv = "5c3e9a10-0000-4000-8000-00000000abcd"
            conv_two = "7d2f0b11-0000-4000-8000-00000000dcba"
            peers = json.loads(text_of(await agy.call_tool("a2a_peers", {}, meta=agy_meta(conv))))
            agy_handle = peers["self"]["handle"]
            assert agy_handle == f"{CARD_AGY}/5c3e9a10~5c3e9a10"
            other = json.loads(text_of(await agy.call_tool("a2a_peers", {}, meta=agy_meta(conv_two))))
            assert other["self"]["handle"] != agy_handle  # one Mcp-Session-Id, two conversations

            sent = await claude.call_tool("a2a_send", {"to": agy_handle, "text": "please review"})
            task_id = json.loads(text_of(sent))["task_id"]

            inbox = json.loads(text_of(await agy.call_tool("a2a_inbox", {}, meta=agy_meta(conv))))
            assert inbox["untrusted"] is True and inbox["tasks"][0]["task_id"] == task_id
            assert inbox["tasks"][0]["origin"] == {"kind": "local", "from": claude_handle, "verified_by_server": True}
            empty = json.loads(text_of(await agy.call_tool("a2a_inbox", {}, meta=agy_meta(conv_two))))
            assert empty["tasks"] == []

            done = await agy.call_tool(
                "a2a_respond", {"task_id": task_id, "state": "completed", "text": "looks good"}, meta=agy_meta(conv)
            )
            assert json.loads(text_of(done))["state"] == "TASK_STATE_COMPLETED"
            got = json.loads(text_of(await claude.call_tool("a2a_get", {"task_id": task_id})))
            assert got["tasks"][0]["messages"][-1]["parts"][0]["text"] == "looks good"
            # The structured content equals the text block.
            structured = (await claude.call_tool("a2a_get", {"task_id": task_id})).structured_content
            assert structured == got

    asyncio.run(scenario())


def test_the_official_client_with_the_wait_tool_over_a_real_socket(served):
    keys = served.env.keys

    async def scenario() -> None:
        async with official_client(served, keys.claude) as claude:
            await claude.call_tool("a2a_hello", {"name": "waiter"})
            started = time.monotonic()
            result = await claude.call_tool("a2a_wait", {"timeout_seconds": 1})
            elapsed = time.monotonic() - started
            assert json.loads(text_of(result)) == {"timed_out": True}
            assert 0.9 <= elapsed < 5

    asyncio.run(scenario())


def test_real_http_scope_and_session_checks_on_the_running_app(served):
    keys = served.env.keys
    body = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-11-25"}}
    with httpx.Client(base_url=served.url) as http:
        for token in (keys.peer, keys.status):
            assert http.post("/mcp", json=body, headers={"Authorization": f"Bearer {token}"}).status_code == 403
        assert http.post("/mcp", json=body).status_code == 401
        mine = http.post("/mcp", json=body, headers={"Authorization": f"Bearer {keys.claude}"})
        assert mine.status_code == 200
        sid = mine.headers["mcp-session-id"]
        call = {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "a2a_inbox", "arguments": {}}}
        stolen = http.post("/mcp", json=call, headers={"Authorization": f"Bearer {keys.claude_other}", "Mcp-Session-Id": sid})
        assert stolen.status_code == 403
        assert http.get("/mcp", headers={"Authorization": f"Bearer {keys.claude}", "Mcp-Session-Id": sid}).status_code == 405
        assert http.post("/healthz").status_code in (200, 405)


def test_build_server_app_wires_the_mcp_endpoint_and_the_audit_store(pg_db):
    """`build_server_app` mounts `/mcp` and passes the SQL audit log to the middleware and the
    service (S1-AUTH's doc listed the audit store as not wired). The engine connects lazily, so no
    server needs to run for this."""
    app = build_server_app(pg_db(allow_writes=True))
    assert app.state.mcp is not None and app.state.audit is not None
    assert any(getattr(route, "path", None) == "/mcp" for route in app.routes)
