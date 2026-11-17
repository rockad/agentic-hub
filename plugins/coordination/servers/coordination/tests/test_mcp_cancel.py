"""S1-MCP: a parked `a2a_wait` must not outlive its caller. Driven at the ASGI level (real endpoint,
real service layer, real Postgres, real `asyncio.sleep`), because the test client cannot disconnect
in the middle of a request."""

from __future__ import annotations

import asyncio
import json

import pytest
from mcp_helpers import CARD_CLAUDE, H_CLAUDE, make_env

from coordination.auth.middleware import PRINCIPAL_KEY
from coordination.auth.records import LOCAL_HARNESS, Principal
from coordination.mcp import build_endpoint


@pytest.fixture
def env(pg_db):
    return make_env(pg_db)


class Call:
    """One ASGI request the test drives by hand: body in, response out, disconnect on demand."""

    def __init__(self, endpoint, principal, body, sid=None):
        headers = [(b"mcp-session-id", sid.encode())] if sid else []
        self.scope = {"type": "http", "method": "POST", "path": "/mcp", "headers": headers, PRINCIPAL_KEY: principal}
        self.body = json.dumps(body).encode()
        self.sent = False
        self.gone = asyncio.Event()
        self.out: list[dict] = []
        self.task = asyncio.ensure_future(endpoint(self.scope, self.receive, self.send))

    async def receive(self):
        if not self.sent:
            self.sent = True
            return {"type": "http.request", "body": self.body, "more_body": False}
        await self.gone.wait()
        return {"type": "http.disconnect"}

    async def send(self, message):
        self.out.append(message)

    @property
    def status(self):
        return next(m["status"] for m in self.out if m["type"] == "http.response.start")

    @property
    def json(self):
        return json.loads(b"".join(m.get("body", b"") for m in self.out if m["type"] == "http.response.body"))

    def header(self, name: str) -> str:
        start = next(m for m in self.out if m["type"] == "http.response.start")
        return next(v.decode() for k, v in start["headers"] if k.decode() == name)


def principal(env) -> Principal:
    return Principal(key_id=env.keys.ids["claude"], scope=LOCAL_HARNESS, name="t", card_id=CARD_CLAUDE)


async def until(predicate, timeout: float = 5.0):
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        assert asyncio.get_running_loop().time() < deadline, "timed out waiting for the condition"
        await asyncio.sleep(0.01)


async def start_session(endpoint, who) -> str:
    init = Call(endpoint, who, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-11-25"}})
    await init.task
    return init.header("mcp-session-id")


def wait_request(rid: int) -> dict:
    return {
        "jsonrpc": "2.0", "id": rid, "method": "tools/call",
        "params": {"name": "a2a_wait", "arguments": {"timeout_seconds": 50, "handle": H_CLAUDE}},
    }


def test_a_disconnect_cancels_the_parked_wait(env):
    env.add_session(H_CLAUDE)

    async def scenario() -> None:
        endpoint = build_endpoint(env.config, env.service, env.engine, env.clock, sleep=asyncio.sleep, poll_s=30)
        who = principal(env)
        sid = await start_session(endpoint, who)
        call = Call(endpoint, who, wait_request(2), sid)
        await until(lambda: len(endpoint._inflight) == 1)  # parked: the tool is running and sleeping
        call.gone.set()  # the client went away
        await asyncio.wait_for(call.task, 2)
        assert endpoint._inflight == {}
        assert call.out == []  # nobody left to answer

    asyncio.run(scenario())


def test_notifications_cancelled_ends_the_parked_wait_with_a_cancelled_error(env):
    env.add_session(H_CLAUDE)

    async def scenario() -> None:
        endpoint = build_endpoint(env.config, env.service, env.engine, env.clock, sleep=asyncio.sleep, poll_s=30)
        who = principal(env)
        sid = await start_session(endpoint, who)
        call = Call(endpoint, who, wait_request(77), sid)
        await until(lambda: len(endpoint._inflight) == 1)
        cancel = Call(
            endpoint, who, {"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 77}}, sid
        )
        await asyncio.wait_for(cancel.task, 2)
        assert cancel.status == 202
        await asyncio.wait_for(call.task, 2)
        assert call.status == 200 and call.json["error"]["code"] == -32800
        assert endpoint._inflight == {}
        call.gone.set()
        cancel.gone.set()

    asyncio.run(scenario())


def test_a_cancel_for_another_sessions_request_does_nothing(env):
    env.add_session(H_CLAUDE)

    async def scenario() -> None:
        endpoint = build_endpoint(env.config, env.service, env.engine, env.clock, sleep=asyncio.sleep, poll_s=30)
        who = principal(env)
        sid, other = await start_session(endpoint, who), await start_session(endpoint, who)
        call = Call(endpoint, who, wait_request(5), sid)
        await until(lambda: len(endpoint._inflight) == 1)
        cancel = Call(endpoint, who, {"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 5}}, other)
        await asyncio.wait_for(cancel.task, 2)
        await asyncio.sleep(0.05)
        assert not call.task.done() and len(endpoint._inflight) == 1  # still parked
        call.gone.set()
        await asyncio.wait_for(call.task, 2)
        cancel.gone.set()

    asyncio.run(scenario())


def test_shutdown_cancels_a_parked_wait_without_leaking_the_tool_task(env):
    env.add_session(H_CLAUDE)

    async def scenario() -> None:
        endpoint = build_endpoint(env.config, env.service, env.engine, env.clock, sleep=asyncio.sleep, poll_s=30)
        who = principal(env)
        sid = await start_session(endpoint, who)
        call = Call(endpoint, who, wait_request(9), sid)
        await until(lambda: len(endpoint._inflight) == 1)
        (tool_task,) = endpoint._inflight.values()
        call.task.cancel()  # what the server does to its handlers on shutdown
        with pytest.raises(asyncio.CancelledError):
            await call.task
        await until(tool_task.done)  # cancellation is delivered on the next turns of the loop
        assert endpoint._inflight == {}

    asyncio.run(scenario())
